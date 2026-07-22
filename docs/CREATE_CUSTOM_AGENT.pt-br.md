# Criando um Agente Customizado

Um guia para iniciantes sobre como definir seu próprio agente picoclaw no
`zombie-crab-project`.

Ao final você terá um novo agente — com persona, skills, modelo e config do
picoclaw próprios — com quem os usuários podem conversar pelo portal.

---

## 1. O que é um "agente" aqui

Um **agente** é uma personalidade picoclaw nomeada (ex.: `alpha`, `beta`). Duas
peças o definem:

1. **Uma entrada em `crab/crab-shell-proxy/config.yaml`** — o nome do agente, qual
   serviço do mycelium roteia até ele, qual modelo LLM ele usa e de qual
   **template** ele é clonado.
2. **Um diretório de template** no disco — os arquivos copiados para o workspace
   privado de cada usuário na primeira vez que ele conversa com o agente (persona,
   skills, config do picoclaw).

Cada usuário recebe sua **própria cópia isolada** do template (workspace próprio,
histórico próprio). O template é o ponto de partida do qual todos são clonados.

---

## 2. Onde os templates ficam

O `crab-shell-proxy` resolve um template em:

```
<data-root>/templates/<nome-do-template>/
```

- **No host:** `<data-root>` é o `CRAB_HOST_DATA_ROOT` do `.env`, com padrão
  `./data` (ou seja, `./data/templates/<nome>/`).
- **Dentro dos containers:** a mesma árvore é montada em `/data`, então o proxy
  enxerga `/data/templates/<nome>/`.

Os agentes de fábrica vêm como `data/templates/alpha/` e `data/templates/beta/`.

### Estrutura do template

```
data/templates/<nome>/
├── config.json          # configuração do picoclaw (OBRIGATÓRIO)
├── .security.yml        # channels + model_list do picoclaw; guarda o slot do token pico
└── workspace/           # semeado no workspace de cada usuário (allowlist abaixo)
    ├── AGENT.md          # o papel / comportamento do agente
    ├── SOUL.md           # a personalidade / voz do agente
    ├── USER.md           # notas sobre o usuário / padrões
    ├── memory/           # notas de memória iniciais (copiado recursivamente)
    └── skills/           # skills iniciais (copiado recursivamente)
```

Só estas entradas de `workspace/` são semeadas (a **allowlist**):
`AGENT.md`, `SOUL.md`, `USER.md`, `memory/`, `skills/`. Qualquer outra coisa em
`workspace/` (em especial `sessions/`, `logs/`, `.picoclaw.pid`) **nunca** é
copiada — é isso que impede o histórico e o estado de runtime de um usuário de
vazar para outro.

Uma skill é uma pasta com um `SKILL.md` (frontmatter YAML `name` + `description`,
seguido de um corpo Markdown):

```
workspace/skills/<nome-da-skill>/SKILL.md
```

---

## 3. Como o seeding funciona (leia antes de subir)

- O template é aplicado na **primeira vez que um dado usuário conversa** com o
  agente ("primeiro provisionamento"). Nesse momento o proxy:
  1. copia `config.json` e `.security.yml` para o diretório de dados do usuário, e
  2. copia a allowlist de `workspace/` para o workspace do usuário.
- Em **todo** turno seguinte o proxy injeta a API key do modelo e um token pico
  recém-gerado no `.security.yml` do usuário — então você **nunca** coloca keys
  ou tokens no template; eles vêm do ambiente.
- Um **usuário recorrente NÃO é re-semeado.** Se alguém já conversou com o agente,
  mudar o template depois **não** mexe no workspace dele — só usuários novos
  recebem a nova versão.

> **Dica de deploy:** prepare seus templates **antes** de alguém usar a
> instância, para que todos sejam clonados da versão final.

> **Auto-bootstrap (rede de segurança).** Se o `data/templates/<name>/` de um
> agente estiver ausente no primeiro provisionamento, o proxy materializa um
> **template picoclaw default embutido no binário**, para que o provisionamento
> nunca falhe num `data/` apagado ou não-semeado. Esse default é a persona
> picoclaw padrão — **não** a sua customizada. Então, para um agente customizado
> você ainda cria o template abaixo (passos 4.1–4.3); o bootstrap só garante uma
> baseline funcional quando você não o faz. Para alterar o próprio default
> embutido, edite
> `crab/crab-shell-proxy/internal/docker/defaulttemplate/<harness>/` (hoje:
> `picoclaw`) e rebuilde o proxy.

---

## 4. Passo-a-passo: adicionar um agente customizado

Vamos criar um agente chamado `meuagente`.

### 4.1 Crie o diretório do template

```bash
mkdir -p data/templates/meuagente/workspace/memory
mkdir -p data/templates/meuagente/workspace/skills
```

### 4.2 Forneça `config.json` e `.security.yml`

O começo mais fácil é copiá-los de um agente de fábrica e ajustar:

```bash
cp data/templates/alpha/config.json    data/templates/meuagente/config.json
cp data/templates/alpha/.security.yml  data/templates/meuagente/.security.yml
```

Você **não** precisa colocar nenhuma API key ou token pico no `.security.yml` — o
proxy preenche provider/nome/key do modelo (a partir do `config.yaml`, ver 4.4) e
o token do canal pico no momento do provisionamento.

### 4.3 Customize a persona, a memória e as skills

Edite os arquivos de `workspace/` para moldar o agente:

- `workspace/AGENT.md` — o que o agente faz e como deve se comportar.
- `workspace/SOUL.md` — sua voz / personalidade.
- `workspace/USER.md` — padrões ou contexto sobre o usuário.
- `workspace/memory/` — notas iniciais que você quer que todo usuário comece.
- `workspace/skills/<skill>/SKILL.md` — skills customizadas. Exemplo:

  ```markdown
  ---
  name: greet
  description: Saúda o usuário calorosamente no idioma dele. Use no início do chat.
  ---

  # Saudação

  Ao iniciar uma conversa, cumprimente o usuário pelo nome se souber...
  ```

### 4.4 Registre o agente no `config.yaml`

Adicione uma entrada em `agents:` no `crab/crab-shell-proxy/config.yaml`:

```yaml
agents:
  meuagente:
    serviceName: "picoclaw-meuagente"   # precisa bater com a chave do serviço no mycelium (4.5)
    token: { env: "MYC_PICOCLAW_MEUAGENTE_TOKEN" }
    template: "meuagente"               # -> data/templates/meuagente/
    mode: "continuous"                  # ou "scale-to-zero"
    idleTimeout: 15m                    # usado apenas pelo scale-to-zero
    model:
      provider: "deepseek"
      name: "deepseek-chat"             # precisa bater com um model_name no model_list do .security.yml
      apiKeyEnv: "PICOCLAW_MEUAGENTE_API_KEY"
```

> **Modo:** `continuous` mantém o container rodando para a sessão em memória não
> ser reiniciada entre turnos; `scale-to-zero` para o container após o
> `idleTimeout`.

### 4.5 Registre a rota no mycelium

No `deploy/standalone/config.standalone.toml` (e o `deploy/<modo>/config.*.toml` correspondente), copie o bloco de serviço `picoclaw-alpha`
existente e renomeie para `picoclaw-meuagente` (os chamadores acessam
`/picoclaw-meuagente/...`). Mantenha o mesmo `token = { env = ... }`,
`healthCheckPath` e as configs de `group`/role — só troque o nome.

### 4.6 Defina as variáveis de ambiente

No `.env` (nunca nos arquivos de config), forneça:

```
MYC_PICOCLAW_MEUAGENTE_TOKEN=<um segredo compartilhado; o mesmo valor que a rota do mycelium usa>
PICOCLAW_MEUAGENTE_API_KEY=<a API key do provedor do LLM>
```

O token autentica as requisições entre o mycelium e o proxy; a API key é injetada
no `.security.yml` de cada usuário.

### 4.7 Rebuild e restart

`config.yaml` é **baked** na imagem do crab-shell-proxy (mudança do lado do proxy
exige rebuild), enquanto o config do mycelium agora é **montado** de `deploy/<modo>/`
(config.standalone.toml / config.base.toml), então uma mudança de rota lá só precisa
de restart. O atalho seguro ainda é rebuildar:

```bash
docker compose up -d --build crab-shell-proxy mycelium-gateway
```

Os **arquivos do template** vivem no volume montado `/data`, então editá-los
depois não exige rebuild — mas lembre da regra do primeiro provisionamento
(seção 3).

---

## 5. Checklist rápido

- [ ] `data/templates/<nome>/config.json` existe
- [ ] `data/templates/<nome>/.security.yml` existe (model_list tem seu modelo; sem keys)
- [ ] `data/templates/<nome>/workspace/{AGENT.md,SOUL.md,USER.md}` escritos
- [ ] Opcional: `workspace/memory/` e `workspace/skills/<skill>/SKILL.md`
- [ ] Entrada do agente adicionada em `crab/crab-shell-proxy/config.yaml` (`template:` aponta para `<nome>`)
- [ ] Rota adicionada em `deploy/standalone/config.standalone.toml` (`picoclaw-<nome>`)
- [ ] `.env` tem `MYC_PICOCLAW_<NOME>_TOKEN` e `PICOCLAW_<NOME>_API_KEY`
- [ ] `docker compose up -d --build crab-shell-proxy mycelium-gateway`
- [ ] Templates finalizados **antes** de os usuários começarem a conversar

---

## 6. Armadilhas comuns

- **"Minhas mudanças no template não apareceram."** Você (ou o usuário) já
  conversou com o agente — usuários recorrentes não são re-semeados. Teste com um
  usuário novo, ou resete o diretório de dados daquele usuário.
- **"Adicionei um agente mas as requisições dão 404."** A rota do mycelium (4.5)
  está faltando ou o gateway não foi rebuildado; os chamadores precisam acessar
  `/picoclaw-<nome>/...`.
- **"A autenticação do modelo falha."** O `apiKeyEnv` no `config.yaml` precisa
  nomear uma env var real, e o `model.name` precisa bater com um `model_name` no
  `model_list` do `.security.yml` do template.
- **Nunca** commite API keys ou tokens — eles pertencem ao `.env` / ao ambiente,
  não ao `config.yaml` nem a um template.

---

Veja também: `.specs/features/agent-customization/` (o design por trás dos
templates customizados e da injeção de secrets).
