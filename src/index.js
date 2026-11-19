import './silenciar-logs.js'; // precisa ser o primeiro import
import express from 'express';
import multer from 'multer';
import QRCode from 'qrcode';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { supabase, BUCKET_FOTOS } from './supabase.js';
import { conectar, desconectar, getStatus, getQr, listarGrupos, enviar } from './whatsapp.js';
import { iniciarAgendador, destravarEnviando, verificarPendentes, proximaData } from './agendador.js';

const PORT = process.env.PORT || 3000;
const SENHA = process.env.PAINEL_SENHA;
const USUARIO = process.env.PAINEL_USUARIO || 'admin';
const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!SENHA) {
  console.error('Defina PAINEL_SENHA nas variáveis de ambiente (protege o painel).');
  process.exit(1);
}

const app = express();
app.use(express.json());

// ---- Rota pública pro UptimeRobot (fica fora da senha) ----
app.get('/health', (_req, res) => res.json({ ok: true, whatsapp: getStatus().status }));

// ---- Daqui pra baixo tudo exige usuário/senha ----
app.use((req, res, next) => {
  const [tipo, valor] = (req.headers.authorization || '').split(' ');
  if (tipo === 'Basic' && valor) {
    const [u, ...resto] = Buffer.from(valor, 'base64').toString().split(':');
    if (u === USUARIO && resto.join(':') === SENHA) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Agendador"').status(401).send('Acesso negado');
});

app.use(express.static(path.join(raiz, 'public')));

app.get('/qr', async (_req, res) => {
  const { status } = getStatus();
  const qr = getQr();
  const corpo = status === 'conectado'
    ? '<h2>✅ WhatsApp conectado</h2><p><a href="/">Ir pro painel</a></p>'
    : qr
      ? `<h2>Escaneie com o WhatsApp</h2>
         <p>Celular → Configurações → Dispositivos conectados → Conectar dispositivo</p>
         <img src="${await QRCode.toDataURL(qr, { width: 320 })}" alt="QR code">
         <p><small>A página atualiza sozinha a cada 15s.</small></p>`
      : `<h2>Aguardando QR code... (status: ${status})</h2>`;
  res.send(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="15">
    <title>Conectar WhatsApp</title>
    <body style="font-family:system-ui;text-align:center;padding:40px">${corpo}</body>`);
});

app.get('/api/status', (_req, res) => res.json(getStatus()));

app.get('/api/grupos', async (_req, res) => {
  try {
    res.json(await listarGrupos());
  } catch (e) {
    res.status(503).json({ erro: e.message });
  }
});

app.get('/api/agendamentos', async (_req, res) => {
  const { data, error } = await supabase
    .from('agendamentos')
    .select('*')
    .order('data_hora', { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ erro: error.message });
  res.json(data);
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 }, // 16 MB
  fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
});

async function subirFoto(arquivo) {
  if (!arquivo) return null;
  const ext = (arquivo.originalname.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
  const caminho = `${randomUUID()}.${ext || 'jpg'}`;
  const { error } = await supabase.storage
    .from(BUCKET_FOTOS)
    .upload(caminho, arquivo.buffer, { contentType: arquivo.mimetype });
  if (error) throw new Error(`Erro ao subir a foto: ${error.message}`);
  return caminho;
}

// Aceita um destino só (destino + destino_nome) ou vários (destinos = JSON [{id, nome}])
function lerDestinos(body) {
  if (body.destinos) {
    let lista;
    try { lista = JSON.parse(body.destinos); } catch { throw new Error('Lista de destinos inválida'); }
    return (Array.isArray(lista) ? lista : [])
      .filter((d) => d?.id)
      .map((d) => ({ destino: String(d.id).trim(), destino_nome: d.nome?.trim() || null }));
  }
  return body.destino ? [{ destino: body.destino.trim(), destino_nome: body.destino_nome?.trim() || null }] : [];
}

const RECORRENCIAS = ['nenhuma', 'diaria', 'semanal', 'mensal'];

// Datas do primeiro envio: "datas" = JSON com várias (um horário cada, no envio diário) ou "data_hora" = uma só
function lerDatas(body) {
  let lista = [];
  if (body.datas) {
    try { lista = JSON.parse(body.datas); } catch { throw new Error('Lista de horários inválida'); }
  } else if (body.data_hora) {
    lista = [body.data_hora];
  }
  if (!Array.isArray(lista) || !lista.length) throw new Error('Informe a data e o horário');
  const datas = lista.map((d) => new Date(d));
  if (datas.some((d) => Number.isNaN(d.getTime()))) throw new Error('Data/hora inválida');
  return [...new Set(datas.map((d) => d.toISOString()))].map((iso) => new Date(iso)); // tira horários repetidos
}

app.post('/api/agendamentos', upload.single('foto'), async (req, res) => {
  try {
    const { mensagem, recorrencia = 'nenhuma' } = req.body;
    if (!RECORRENCIAS.includes(recorrencia)) return res.status(400).json({ erro: 'Repetição inválida' });
    const destinos = lerDestinos(req.body);
    if (!destinos.length) return res.status(400).json({ erro: 'Escolha pelo menos um destino' });
    if (!mensagem?.trim() && !req.file) return res.status(400).json({ erro: 'Escreva uma mensagem ou anexe uma foto' });

    let datas;
    try { datas = lerDatas(req.body); } catch (e) { return res.status(400).json({ erro: e.message }); }

    let termina_em = null;
    if (req.body.termina_em) {
      termina_em = new Date(req.body.termina_em);
      if (Number.isNaN(termina_em.getTime())) return res.status(400).json({ erro: 'Data de término inválida' });
    }

    // Repetição com o primeiro horário já passado (ex.: começa hoje às 8h e agora são 14h):
    // pula pra próxima vez, em vez de mandar atrasado na hora
    const agora = new Date(Date.now() - 60_000);
    if (recorrencia !== 'nenhuma') {
      datas = datas.map((d) => (d < agora ? proximaData(d, recorrencia, agora) : d));
    }
    if (termina_em && datas.every((d) => d > termina_em)) {
      return res.status(400).json({ erro: 'A data de término é antes do primeiro envio' });
    }

    // A foto sobe uma vez só e é compartilhada por todos os destinos e horários
    const foto_path = await subirFoto(req.file);
    const lote = randomUUID(); // liga os agendamentos criados juntos (pra editar todos de uma vez)
    const linhas = destinos.flatMap((d) =>
      datas
        .filter((data) => !termina_em || data <= termina_em)
        .map((data) => ({
          ...d,
          mensagem: mensagem?.trim() || null,
          foto_path,
          data_hora: data.toISOString(),
          recorrencia,
          termina_em: termina_em?.toISOString() ?? null,
          lote,
        })),
    );
    const { data, error } = await supabase.from('agendamentos').insert(linhas).select();
    if (error) throw error;
    res.status(201).json(data);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Só apaga a foto do Storage se nenhum agendamento ainda usa ela (a foto é compartilhada entre grupos/horários)
async function removerFotoSeOrfa(foto) {
  if (!foto) return;
  const { count, error } = await supabase
    .from('agendamentos')
    .select('id', { count: 'exact', head: true })
    .eq('foto_path', foto);
  if (!error && count === 0) await supabase.storage.from(BUCKET_FOTOS).remove([foto]); // na dúvida, mantém
}

// Mostra a foto de um agendamento (o bucket é privado, então passa pelo servidor)
app.get('/api/agendamentos/:id/foto', async (req, res) => {
  const { data: item } = await supabase.from('agendamentos').select('foto_path').eq('id', req.params.id).maybeSingle();
  if (!item?.foto_path) return res.status(404).end();
  const { data, error } = await supabase.storage.from(BUCKET_FOTOS).download(item.foto_path);
  if (error) return res.status(404).end();
  res.type(data.type || 'image/jpeg').set('Cache-Control', 'private, max-age=300');
  res.send(Buffer.from(await data.arrayBuffer()));
});

// Editar: texto, foto, data do próximo envio, repetição e término.
// Com aplicar_lote=1, o texto e a foto mudam também nos outros agendamentos criados junto (outros grupos/horários).
app.patch('/api/agendamentos/:id', upload.single('foto'), async (req, res) => {
  try {
    const { data: atual, error: erroBusca } = await supabase
      .from('agendamentos').select('*').eq('id', req.params.id).maybeSingle();
    if (erroBusca) throw erroBusca;
    if (!atual) return res.status(404).json({ erro: 'Agendamento não encontrado' });
    if (['enviado', 'enviando'].includes(atual.status)) {
      return res.status(409).json({ erro: 'Essa mensagem já foi enviada, não dá mais pra alterar' });
    }

    const b = req.body;
    const recorrencia = b.recorrencia ?? atual.recorrencia;
    if (!RECORRENCIAS.includes(recorrencia)) return res.status(400).json({ erro: 'Repetição inválida' });
    const mensagem = b.mensagem !== undefined ? b.mensagem.trim() || null : atual.mensagem;

    let data_hora = b.data_hora ? new Date(b.data_hora) : new Date(atual.data_hora);
    if (Number.isNaN(data_hora.getTime())) return res.status(400).json({ erro: 'Data/hora inválida' });
    const agora = new Date(Date.now() - 60_000);
    if (recorrencia !== 'nenhuma' && data_hora < agora) data_hora = proximaData(data_hora, recorrencia, agora);

    let termina_em = atual.termina_em ? new Date(atual.termina_em) : null;
    if (b.termina_em !== undefined) termina_em = b.termina_em ? new Date(b.termina_em) : null;
    if (recorrencia === 'nenhuma') termina_em = null;
    if (termina_em && Number.isNaN(termina_em.getTime())) return res.status(400).json({ erro: 'Data de término inválida' });
    if (termina_em && data_hora > termina_em) return res.status(400).json({ erro: 'A data de término é antes do próximo envio' });

    const fotoAntiga = atual.foto_path;
    let foto_path = fotoAntiga;
    if (b.remover_foto === '1') foto_path = null;
    if (!mensagem && !foto_path && !req.file) return res.status(400).json({ erro: 'Precisa ter mensagem ou foto' });
    if (req.file) foto_path = await subirFoto(req.file);

    const { data, error } = await supabase
      .from('agendamentos')
      .update({
        mensagem, foto_path, recorrencia,
        data_hora: data_hora.toISOString(),
        termina_em: termina_em?.toISOString() ?? null,
        status: 'pendente', erro: null,
      })
      .eq('id', atual.id)
      .select()
      .single();
    if (error) throw error;

    let outros = 0;
    if (b.aplicar_lote === '1' && atual.lote) {
      const { data: atualizados, error: erroLote } = await supabase
        .from('agendamentos')
        .update({ mensagem, foto_path })
        .eq('lote', atual.lote)
        .neq('id', atual.id)
        .in('status', ['pendente', 'erro', 'expirado'])
        .select('id');
      if (erroLote) throw erroLote;
      outros = atualizados?.length || 0;
    }

    if (fotoAntiga && fotoAntiga !== foto_path) await removerFotoSeOrfa(fotoAntiga);
    res.json({ ...data, outros_atualizados: outros });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/api/agendamentos/:id/cancelar', async (req, res) => {
  const { error } = await supabase
    .from('agendamentos')
    .update({ status: 'cancelado' })
    .eq('id', req.params.id)
    .in('status', ['pendente', 'erro']);
  if (error) return res.status(500).json({ erro: error.message });
  res.json({ ok: true });
});

app.delete('/api/agendamentos/:id', async (req, res) => {
  const { data, error } = await supabase.from('agendamentos').delete().eq('id', req.params.id).select('foto_path');
  if (error) return res.status(500).json({ erro: error.message });
  await removerFotoSeOrfa(data?.[0]?.foto_path);
  res.json({ ok: true });
});

// Envia na hora (sem agendar), pra um ou vários destinos
app.post('/api/teste', upload.single('foto'), async (req, res) => {
  try {
    const destinos = lerDestinos(req.body);
    if (!destinos.length) return res.status(400).json({ erro: 'Escolha pelo menos um destino' });
    const falhas = [];
    for (const d of destinos) {
      try {
        await enviar({ destino: d.destino, mensagem: req.body.mensagem || 'Teste do agendador ✅', foto: req.file?.buffer || null });
      } catch (e) {
        falhas.push(`${d.destino_nome || d.destino}: ${e.message}`);
      }
      if (destinos.length > 1) await new Promise((r) => setTimeout(r, 1500));
    }
    if (falhas.length) return res.status(500).json({ erro: falhas.join(' | ') });
    res.json({ ok: true, enviados: destinos.length });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/api/desconectar', async (_req, res) => {
  await desconectar();
  res.json({ ok: true });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ erro: err.message });
});

async function iniciarWhatsApp(tentativa = 1) {
  try {
    await conectar();
  } catch (e) {
    const espera = Math.min(60, 5 * tentativa);
    console.error(`Erro ao iniciar o WhatsApp (${e.message}). Tentando de novo em ${espera}s...`);
    setTimeout(() => iniciarWhatsApp(tentativa + 1), espera * 1000);
  }
}

app.listen(PORT, async () => {
  console.log(`Servidor na porta ${PORT}`);
  await destravarEnviando().catch(() => {});
  iniciarWhatsApp();
  iniciarAgendador();
  // assim que conectar, já manda o que venceu enquanto estava fora
  setTimeout(verificarPendentes, 20_000);
});