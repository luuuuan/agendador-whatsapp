// Guarda a sessão do Baileys no Supabase (tabela whatsapp_auth) em vez de arquivos,
// porque o disco do Render free é apagado a cada restart.
import { BufferJSON, initAuthCreds, proto } from 'baileys';
import { supabase } from './supabase.js';

const TABELA = 'whatsapp_auth';

const serializar = (valor) => JSON.parse(JSON.stringify(valor, BufferJSON.replacer));
const desserializar = (valor) => JSON.parse(JSON.stringify(valor), BufferJSON.reviver);

async function ler(id) {
  const { data, error } = await supabase.from(TABELA).select('data').eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? desserializar(data.data) : null;
}

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

export async function apagarSessao() {
  const { error } = await supabase.from(TABELA).delete().neq('id', '');
  if (error) throw error;
}

export async function useSupabaseAuthState() {
  const creds = (await ler('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (tipo, ids) => {
          const resultado = {};
          if (!ids.length) return resultado;
          const chaves = ids.map((id) => `${tipo}-${id}`);
          const { data, error } = await supabase.from(TABELA).select('id, data').in('id', chaves);
          if (error) throw error;
          const mapa = new Map((data || []).map((l) => [l.id, desserializar(l.data)]));
          for (const id of ids) {
            let valor = mapa.get(`${tipo}-${id}`) ?? null;
            if (tipo === 'app-state-sync-key' && valor) {
              valor = proto.Message.AppStateSyncKeyData.fromObject(valor);
            }
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
              const chave = `${tipo}-${id}`;
              if (valor) salvar.push({ id: chave, valor });
              else remover.push(chave);
            }
          }
          await Promise.all([gravar(salvar), apagar(remover)]);
        },
      },
    },
    saveCreds: () => gravar([{ id: 'creds', valor: creds }]),
  };
}
