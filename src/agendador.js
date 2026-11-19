import cron from 'node-cron';
import { supabase, BUCKET_FOTOS } from './supabase.js';
import { enviar, getStatus } from './whatsapp.js';

// Se o servidor ficou fora do ar e a mensagem atrasou mais que isso, ela não é enviada
// (vira "expirado"; nas recorrentes, pula pra próxima data). Padrão: 12 horas.
const MAX_ATRASO_MIN = Number(process.env.MAX_ATRASO_MIN || 720);

let rodando = false;

export function proximaData(dataAtual, recorrencia, agora = new Date()) {
  const d = new Date(dataAtual);
  do {
    if (recorrencia === 'diaria') d.setUTCDate(d.getUTCDate() + 1);
    else if (recorrencia === 'semanal') d.setUTCDate(d.getUTCDate() + 7);
    else if (recorrencia === 'mensal') d.setUTCMonth(d.getUTCMonth() + 1);
    else return null;
  } while (d <= agora);
  return d;
}

async function baixarFoto(path) {
  const { data, error } = await supabase.storage.from(BUCKET_FOTOS).download(path);
  if (error) throw new Error(`Não consegui baixar a foto: ${error.message}`);
  return Buffer.from(await data.arrayBuffer());
}

async function finalizar(item, campos) {
  const agora = new Date();
  const proxima = proximaData(item.data_hora, item.recorrencia, agora);
  const atualizacao = proxima
    ? { ...campos, status: 'pendente', data_hora: proxima.toISOString() } // recorrente: volta pra fila
    : campos;
  const { error } = await supabase.from('agendamentos').update(atualizacao).eq('id', item.id);
  if (error) console.error(`Erro ao atualizar agendamento ${item.id}:`, error.message);
}

async function processar(item) {
  const atrasoMin = (Date.now() - new Date(item.data_hora).getTime()) / 60_000;

  if (atrasoMin > MAX_ATRASO_MIN) {
    console.log(`Agendamento ${item.id} atrasou ${Math.round(atrasoMin)} min, pulando.`);
    await finalizar(item, { status: 'expirado', erro: `Atrasou ${Math.round(atrasoMin)} min (servidor fora do ar?)` });
    return;
  }

  try {
    const foto = item.foto_path ? await baixarFoto(item.foto_path) : null;
    await enviar({ destino: item.destino, mensagem: item.mensagem, foto });
    console.log(`Enviado: ${item.id} -> ${item.destino_nome || item.destino}`);
    await finalizar(item, { status: 'enviado', erro: null, enviado_em: new Date().toISOString() });
  } catch (e) {
    console.error(`Falha no agendamento ${item.id}:`, e.message);
    await finalizar(item, { status: 'erro', erro: e.message });
  }
}

export async function verificarPendentes() {
  if (rodando) return;
  if (getStatus().status !== 'conectado') return; // espera conectar; quando voltar, envia o que venceu
  rodando = true;
  try {
    // "Reserva" os vencidos trocando o status pra enviando (evita envio duplicado)
    const { data, error } = await supabase
      .from('agendamentos')
      .update({ status: 'enviando' })
      .eq('status', 'pendente')
      .lte('data_hora', new Date().toISOString())
      .select('*');
    if (error) throw error;

    for (const item of (data || []).sort((a, b) => new Date(a.data_hora) - new Date(b.data_hora))) {
      await processar(item);
      await new Promise((r) => setTimeout(r, 1500)); // pausa entre envios
    }
  } catch (e) {
    console.error('Erro ao verificar agendamentos:', e.message);
  } finally {
    rodando = false;
  }
}

export async function destravarEnviando() {
  // Se o servidor caiu no meio de um envio, devolve pra fila
  await supabase.from('agendamentos').update({ status: 'pendente' }).eq('status', 'enviando');
}

export function iniciarAgendador() {
  cron.schedule('* * * * *', verificarPendentes); // a cada minuto
  console.log('Agendador rodando (verifica a cada minuto).');
}
