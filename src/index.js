import express from 'express';
import multer from 'multer';
import QRCode from 'qrcode';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { supabase, BUCKET_FOTOS } from './supabase.js';
import { conectar, desconectar, getStatus, getQr, listarGrupos, enviar } from './whatsapp.js';
import { iniciarAgendador, destravarEnviando, verificarPendentes } from './agendador.js';

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

app.post('/api/agendamentos', upload.single('foto'), async (req, res) => {
  try {
    const { destino, destino_nome, mensagem, data_hora, recorrencia = 'nenhuma' } = req.body;
    if (!destino) return res.status(400).json({ erro: 'Informe o destino' });
    if (!data_hora || Number.isNaN(Date.parse(data_hora))) return res.status(400).json({ erro: 'Data/hora inválida' });
    if (!mensagem?.trim() && !req.file) return res.status(400).json({ erro: 'Escreva uma mensagem ou anexe uma foto' });

    const foto_path = await subirFoto(req.file);
    const { data, error } = await supabase
      .from('agendamentos')
      .insert({
        destino: destino.trim(),
        destino_nome: destino_nome?.trim() || null,
        mensagem: mensagem?.trim() || null,
        foto_path,
        data_hora: new Date(data_hora).toISOString(),
        recorrencia,
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
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
  const foto = data?.[0]?.foto_path;
  if (foto) await supabase.storage.from(BUCKET_FOTOS).remove([foto]);
  res.json({ ok: true });
});

// Envia uma mensagem de teste na hora (sem agendar)
app.post('/api/teste', upload.single('foto'), async (req, res) => {
  try {
    const { destino, mensagem } = req.body;
    if (!destino) return res.status(400).json({ erro: 'Informe o destino' });
    await enviar({ destino, mensagem: mensagem || 'Teste do agendador ✅', foto: req.file?.buffer || null });
    res.json({ ok: true });
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
