// Gerencia uma conexão de WhatsApp por usuário.
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from 'baileys';
import pino from 'pino';
import { useSupabaseAuthState, apagarSessao, usuariosComSessao } from './auth-state.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

// usuarioId -> { sock, status, qr, tentativas, encerrada }
// status: desconectado | iniciando | aguardando_qr | conectado
const sessoes = new Map();

let versaoWA;
async function versao() {
  if (!versaoWA) versaoWA = (await fetchLatestBaileysVersion().catch(() => ({}))).version;
  return versaoWA;
}

export function getStatus(usuarioId) {
  const s = sessoes.get(usuarioId);
  return { status: s?.status || 'desconectado', temQr: Boolean(s?.qr), aviso: s?.aviso || null };
}

export const getQr = (usuarioId) => sessoes.get(usuarioId)?.qr || null;

export const usuariosConectados = () =>
  [...sessoes.entries()].filter(([, s]) => s.status === 'conectado').map(([id]) => id);

export async function conectar(usuarioId) {
  const atual = sessoes.get(usuarioId);
  if (atual && ['iniciando', 'aguardando_qr', 'conectado'].includes(atual.status)) return; // já está ativo

  const sessao = atual || { tentativas: 0 };
  Object.assign(sessao, { status: 'iniciando', qr: null, encerrada: false, aviso: null, teveQr: false });
  sessoes.set(usuarioId, sessao);

  const { state, saveCreds } = await useSupabaseAuthState(usuarioId);
  const sock = makeWASocket({
    version: await versao(),
    logger,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    browser: Browsers.ubuntu('Agendador'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  sessao.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (sessao.sock !== sock) return; // evento de um socket antigo

    if (qr) {
      sessao.qr = qr;
      sessao.teveQr = true;
      sessao.status = 'aguardando_qr';
    }

    if (connection === 'open') {
      Object.assign(sessao, { qr: null, status: 'conectado', tentativas: 0, aviso: null });
      console.log(`[${usuarioId.slice(0, 8)}] WhatsApp conectado.`);
    }

    if (connection === 'close') {
      sessao.status = 'desconectado';
      sessao.qr = null;
      const codigo = lastDisconnect?.error?.output?.statusCode;

      if (sessao.encerrada) return; // o próprio usuário desconectou pelo painel

      if (codigo === DisconnectReason.loggedOut) {
        console.log(`[${usuarioId.slice(0, 8)}] Removido do celular. Sessão apagada.`);
        sessao.aviso = 'Este aparelho foi desconectado pelo celular. Gere um QR code novo pra conectar de novo.';
        await apagarSessao(usuarioId).catch((e) => console.error('Erro ao limpar sessão:', e.message));
        return; // o usuário conecta de novo pelo painel quando quiser
      }

      // Ainda não leu o QR (o código expirou): não fica gerando QR pra sempre
      if (!state.creds.registered && !state.creds.me) {
        sessao.aviso = sessao.teveQr
          ? 'O QR code expirou antes de ser lido. Gere outro e escaneie em até 1 minuto.'
          : 'Não consegui falar com o WhatsApp agora. Tente de novo em instantes.';
        console.log(`[${usuarioId.slice(0, 8)}] Conexão encerrada sem leitura do QR (código ${codigo}).`);
        return;
      }

      sessao.tentativas += 1;
      const espera = Math.min(60_000, 2_000 * sessao.tentativas);
      console.log(`[${usuarioId.slice(0, 8)}] Conexão caiu (código ${codigo}). Reconectando em ${espera / 1000}s...`);
      setTimeout(() => conectar(usuarioId).catch((e) => console.error('Falha ao reconectar:', e.message)), espera);
    }
  });
}

export async function desconectar(usuarioId) {
  const sessao = sessoes.get(usuarioId);
  if (sessao) {
    sessao.encerrada = true;
    await sessao.sock?.logout().catch(() => {});
    sessao.sock?.end?.(undefined);
    sessoes.delete(usuarioId);
  }
  await apagarSessao(usuarioId);
}

// Na subida do servidor: reconecta todo mundo que já tinha lido o QR antes
export async function reconectarTodos() {
  const ids = await usuariosComSessao();
  for (const id of ids) {
    await conectar(id).catch((e) => console.error(`[${id.slice(0, 8)}] Falha ao conectar:`, e.message));
    await new Promise((r) => setTimeout(r, 1000));
  }
  return ids.length;
}

function sockConectado(usuarioId) {
  const s = sessoes.get(usuarioId);
  if (!s?.sock || s.status !== 'conectado') throw new Error('Seu WhatsApp não está conectado');
  return s.sock;
}

// Aceita número (com ou sem 55, com ou sem máscara) ou id de grupo (...@g.us)
async function resolverDestino(sock, destino) {
  const bruto = String(destino).trim();
  if (bruto.endsWith('@g.us') || bruto.endsWith('@s.whatsapp.net') || bruto.endsWith('@lid')) return bruto;

  let numero = bruto.replace(/\D/g, '');
  if (numero.length === 10 || numero.length === 11) numero = `55${numero}`; // sem DDI -> Brasil

  // onWhatsApp resolve o jid certo (inclusive a confusão do 9º dígito)
  const [resultado] = await sock.onWhatsApp(numero);
  if (!resultado?.exists) throw new Error(`O número ${numero} não tem WhatsApp`);
  return resultado.jid;
}

export async function enviar(usuarioId, { destino, mensagem, foto }) {
  const sock = sockConectado(usuarioId);
  const jid = await resolverDestino(sock, destino);
  if (foto) await sock.sendMessage(jid, { image: foto, caption: mensagem || undefined });
  else await sock.sendMessage(jid, { text: mensagem });
}

export async function listarGrupos(usuarioId) {
  const sock = sockConectado(usuarioId);
  const grupos = await sock.groupFetchAllParticipating();
  return Object.values(grupos)
    .map((g) => ({ id: g.id, nome: g.subject }))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}
