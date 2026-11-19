# Agendador de WhatsApp

Agenda mensagens de texto e fotos pra contatos ou grupos, com repetição diária, semanal ou mensal.

- **Render (free):** roda o servidor (Node + Baileys), conectado no seu WhatsApp como um "WhatsApp Web".
- **Supabase:** guarda os agendamentos, as fotos (Storage) e a sessão do WhatsApp. Assim, quando o Render reinicia, não precisa escanear o QR de novo.
- **UptimeRobot:** dá um ping a cada 5 min pra o Render não dormir.

## 1. Supabase

1. Crie um projeto em supabase.com.
2. Vá em **SQL Editor → New query**, cole o conteúdo de `supabase.sql` e clique em **Run**. Isso cria as tabelas e o bucket `fotos`.
3. Em **Project Settings → API**, copie:
   - **Project URL** → `SUPABASE_URL`
   - **service_role** (secret) → `SUPABASE_SERVICE_ROLE_KEY`

> A service_role key dá acesso total ao banco. Ela só fica no Render; nunca coloque no código nem no GitHub.

## 2. GitHub

Suba a pasta num repositório (pode ser privado). O `.env` já está no `.gitignore`.

```bash
git init
git add .
git commit -m "agendador de whatsapp"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/agendador-whatsapp.git
git push -u origin main
```

## 3. Render (em um workspace separado do Radar)

As 750h grátis por mês são **por workspace**. Se este serviço ficar no mesmo workspace do Radar de Licitações, os dois juntos passam do limite e o Render suspende tudo até o mês seguinte.

1. No Render, crie um workspace novo pelo menu de workspaces (no topo do dashboard). Se preferir, use outra conta.
2. **New → Web Service** → conecte o repositório.
3. Configuração:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
4. Em **Environment**, adicione as variáveis (veja `.env.example`):

| Variável | Valor |
|---|---|
| `SUPABASE_URL` | URL do projeto |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key |
| `PAINEL_USUARIO` | ex.: `nicole` |
| `PAINEL_SENHA` | uma senha forte |
| `TZ` | `America/Sao_Paulo` |

5. Faça o deploy e espere aparecer `Servidor na porta ...` nos logs.

## 4. Conectar o WhatsApp

1. Abra `https://SEU-APP.onrender.com/qr` e entre com o usuário e a senha do painel.
2. No celular: **Configurações → Dispositivos conectados → Conectar dispositivo** e escaneie o código.
3. Quando aparecer "✅ WhatsApp conectado", é só abrir `https://SEU-APP.onrender.com` e usar o painel.

## 5. UptimeRobot

1. Crie uma conta em uptimerobot.com.
2. **New monitor**:
   - **Type:** HTTP(s)
   - **URL:** `https://SEU-APP.onrender.com/health`
   - **Interval:** 5 minutos
3. Pronto. O `/health` não pede senha, justamente pra o ping funcionar.

## Como usar o painel

- **Contato:** digite o número com DDD (ex.: `45 99999-9999`). O `55` é colocado sozinho.
- **Grupo:** escolha na lista (aparecem os grupos de que você participa).
- **Foto:** opcional. Se tiver mensagem junto, ela vai como legenda. Limite de 16 MB.
- **Repetir:** todo dia, toda semana ou todo mês, sempre no mesmo horário.
- **Enviar agora (teste):** manda na hora, sem agendar. Bom pra conferir se está tudo funcionando.

### Status dos agendamentos

| Status | Significado |
|---|---|
| `pendente` | aguardando o horário |
| `enviado` | foi enviado |
| `erro` | deu problema (o motivo aparece no card, ex.: número sem WhatsApp) |
| `expirado` | o servidor ficou fora do ar e passou do atraso máximo (padrão 12h, ajustável em `MAX_ATRASO_MIN`) |
| `cancelado` | você cancelou |

Se o Render reiniciar perto do horário de um envio, a mensagem sai assim que ele voltar e reconectar (normalmente em 1 ou 2 minutos).

## Rodar no seu PC (opcional)

```bash
cp .env.example .env   # e preencha
npm install
npm run dev
```

Abra http://localhost:3000. Atenção: se rodar local e no Render ao mesmo tempo, os dois vão disputar a mesma sessão. Use um de cada vez.

## Cuidados

- O Baileys é uma biblioteca **não oficial**. Pra uso pessoal, com poucas mensagens pra quem você conhece, o risco é baixo. Não use pra disparo em massa, porque o número pode ser banido.
- Pra desconectar, remova o dispositivo "Agendador" em **Dispositivos conectados** no celular. O servidor percebe, limpa a sessão e gera um QR novo.
