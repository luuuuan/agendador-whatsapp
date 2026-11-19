import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from 'baileys';
import pino from 'pino';
import { useSupabaseAuthState, apagarSessao } from './auth-state.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

let sock = null;
let status = 'iniciando'; // iniciando | aguardando_qr | conectado | desconectado
let qrAtual = null;
let tentativas = 0;

export const getStatus = () => ({ status, temQr: Boolean(qrAtual) });
export const getQr = () => qrAtual;

export async function conectar() {
  const { state, saveCreds } = await useSupabaseAuthState();
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  sock = makeWASocket({
    version,
    logger,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    browser: Browsers.ubuntu('Agendador'),
    markOnlineOnConnect: false, // não aparece "online" pros contatos
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrAtual = qr;
      status = 'aguardando_qr';
      console.log('QR code novo disponível em /qr');
    }

    if (connection === 'open') {
      qrAtual = null;
      status = 'conectado';
      tentativas = 0;
      console.log('WhatsApp conectado.');
    }

    if (connection === 'close') {
      status = 'desconectado';
      const codigo = lastDisconnect?.error?.output?.statusCode;

      if (codigo === DisconnectReason.loggedOut) {
        console.log('Sessão encerrada no celular. Limpando e gerando QR novo...');
        await apagarSessao().catch((e) => console.error('Erro ao limpar sessão:', e.message));
      }

      tentativas += 1;
      const espera = Math.min(30_000, 2_000 * tentativas);
      console.log(`Conexão fechada (código ${codigo}). Reconectando em ${espera / 1000}s...`);
      setTimeout(() => conectar().catch((e) => console.error('Falha ao reconectar:', e.message)), espera);
    }
  });
}

export async function desconectar() {
  if (sock) await sock.logout().catch(() => {});
  await apagarSessao();
}

function exigirConexao() {
  if (!sock || status !== 'conectado') throw new Error('WhatsApp não está conectado');
}

// Aceita número (com ou sem 55, com ou sem máscara) ou id de grupo (...@g.us)
export async function resolverDestino(destino) {
  exigirConexao();
  const bruto = String(destino).trim();
  if (bruto.endsWith('@g.us') || bruto.endsWith('@s.whatsapp.net') || bruto.endsWith('@lid')) return bruto;

  let numero = bruto.replace(/\D/g, '');
  if (numero.length === 10 || numero.length === 11) numero = `55${numero}`; // sem DDI -> Brasil

  // onWhatsApp resolve o jid certo (inclusive a confusão do 9º dígito)
  const [resultado] = await sock.onWhatsApp(numero);
  if (!resultado?.exists) throw new Error(`O número ${numero} não tem WhatsApp`);
  return resultado.jid;
}

export async function enviar({ destino, mensagem, foto }) {
  exigirConexao();
  const jid = await resolverDestino(destino);
  if (foto) {
    await sock.sendMessage(jid, { image: foto, caption: mensagem || undefined });
  } else {
    await sock.sendMessage(jid, { text: mensagem });
  }
}

export async function listarGrupos() {
  exigirConexao();
  const grupos = await sock.groupFetchAllParticipating();
  return Object.values(grupos)
    .map((g) => ({ id: g.id, nome: g.subject }))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}
