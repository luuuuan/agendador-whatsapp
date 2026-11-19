// Guarda a sessão do Baileys no Supabase (tabela whatsapp_auth) em vez de arquivos,
// porque o disco do Render free é apagado a cada restart.
// Cada usuário tem a própria sessão: as linhas são prefixadas com "<usuario_id>:".
import { BufferJSON, initAuthCreds, proto } from 'baileys';
import { supabase } from './supabase.js';

const TABELA = 'whatsapp_auth';

const serializar = (valor) => JSON.parse(JSON.stringify(valor, BufferJSON.replacer));
const desserializar = (valor) => JSON.parse(JSON.stringify(valor), BufferJSON.reviver);

async function gravar(linhas) {
  if (!linhas.length) return;
  const { error } = await supabase.from(TABELA).upsert(
    linhas.map(({ id, valor }) => ({ id, data: serializar(valor), updated_at: new Date().toISOString() })),
  );
  if (error) throw error;
}

async function apagar(ids) {
  if (!ids.length) return;
  const { error } = await supabase.from(TABELA).delete().in('id', ids);
  if (error) throw error;
}

export async function apagarSessao(usuarioId) {
  const { error } = await supabase.from(TABELA).delete().like('id', `${usuarioId}:%`);
  if (error) throw error;
}

// Usuários que já leram o QR code alguma vez (têm credenciais salvas)
export async function usuariosComSessao() {
  const { data, error } = await supabase.from(TABELA).select('id').like('id', '%:creds');
  if (error) throw error;
  return (data || []).map((l) => l.id.split(':')[0]);
}

export async function useSupabaseAuthState(usuarioId) {
  const pre = `${usuarioId}:`;
  const { data: linhaCreds, error } = await supabase.from(TABELA).select('data').eq('id', `${pre}creds`).maybeSingle();
  if (error) throw error;
  const creds = linhaCreds ? desserializar(linhaCreds.data) : initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (tipo, ids) => {
          const resultado = {};
          if (!ids.length) return resultado;
          const { data, error: erro } = await supabase
            .from(TABELA).select('id, data').in('id', ids.map((id) => `${pre}${tipo}-${id}`));
          if (erro) throw erro;
          const mapa = new Map((data || []).map((l) => [l.id, desserializar(l.data)]));
          for (const id of ids) {
            let valor = mapa.get(`${pre}${tipo}-${id}`) ?? null;
            if (tipo === 'app-state-sync-key' && valor) valor = proto.Message.AppStateSyncKeyData.fromObject(valor);
            resultado[id] = valor;
          }
          return resultado;
        },
        set: async (dados) => {
          const salvar = [];
          const remover = [];
          for (const tipo in dados) {
            for (const id in dados[tipo]) {
              const valor = dados[tipo][id];
              const chave = `${pre}${tipo}-${id}`;
              if (valor) salvar.push({ id: chave, valor });
              else remover.push(chave);
            }
          }
          await Promise.all([gravar(salvar), apagar(remover)]);
        },
      },
    },
    saveCreds: () => gravar([{ id: `${pre}creds`, valor: creds }]),
  };
}
