# Guia do Administrador

Operações do dia-a-dia pela **área de admin do chat-webapp**: injetar arquivos,
secrets e skills compartilhados nos agentes dos usuários, registrar modelos por
agente e atribuí-los a usuários individuais, revisar membros e definir branding.

Para *criar* um novo agente, veja [Criando um Agente Customizado](./CREATE_CUSTOM_AGENT.pt-br.md).
Para subir/resetar o stack inteiro, veja o
[README](../README.pt-br.md#rodando-e-resetando-do-zero) na raiz.

---

## 1. Quem administra, e escopos

A área de admin fica acessível pelo **chat-webapp** para contas que gerenciam um
**escopo**. Um escopo é:

- **Tenant** — tudo sob um tenant.
- **Subscription** — uma conta de subscription sob um tenant.

Tudo na área de admin opera **sobre o escopo selecionado** (a trilha de escopo
no topo). As mudanças cascateiam para os containers picoclaw dos usuários
daquele escopo. **Branding** é a exceção — é global à instância e só staff edita.

O modelo mental: você edita material **compartilhado** num escopo, o proxy
sincroniza numa visão **efetiva**, e o container de cada usuário monta essa
visão como somente-leitura. Um usuário nunca vê o workspace privado de outro —
apenas o material compartilhado que você injetou no escopo dele.

---

## 2. Shared files (arquivos compartilhados)

Injeta arquivos arbitrários no workspace do agente de cada usuário do escopo.

1. Abra **Shared files**.
2. Escolha o escopo.
3. Faça upload dos arquivos.

Os agentes dos usuários passam a vê-los no workspace. Use para documentos de
referência, datasets ou qualquer conteúdo estático que os agentes devam ler.

---

## 3. Shared secrets (secrets compartilhados)

Fornece secrets (chaves de API, tokens, strings de conexão) aos agentes de um
escopo **sem** embuti-los em templates ou imagens.

Formatos suportados:

- **dotenv** — linhas `KEY=value`.
- **json** — um objeto JSON plano de pares chave/valor.
- **file** — upload de um arquivo de secret como está.

> O formato **nativo** de secret do picoclaw (model API key) **não** está
> disponível aqui de propósito. Credenciais de modelo são gerenciadas por agente
> na aba **Model** (seção 5), não como secret compartilhado.

Os secrets são gravados no store de shared-secrets do escopo e sincronizados na
visão efetiva montada somente-leitura no agente de cada usuário.

---

## 4. Shared skills (skills compartilhadas)

Envia skills (um `SKILL.md` mais arquivos de apoio opcionais) para os agentes de
todos os usuários de um escopo. Uma skill é uma pasta com um `SKILL.md`
(frontmatter YAML `name` + `description`, depois um corpo Markdown) — o mesmo
formato usado em `workspace/skills/<name>/` de um template.

1. Abra **Shared skills**, escolha o escopo.
2. Adicione uma skill:
   - escrevendo/editando o documento `SKILL.md` inline, ou
   - fazendo upload de um **zip** da pasta da skill.
3. Arquive ou exclua uma skill para removê-la do escopo.

O proxy sincroniza as skills do escopo na visão effective-skills e a monta
somente-leitura no agente de cada usuário. Editar uma skill re-sincroniza no
lugar (o inode do mount é preservado, então agentes em execução a enxergam).

---

## 5. Model — registro por agente e atribuição por usuário

A aba **Model** permite ao admin registrar modelos LLM **por agente** e então
atribuir um modelo registrado a **usuários individuais** daquele agente. É
admin-only: usuários comuns não trocam o próprio modelo.

### 5.1 Registrar um modelo (por agente)

1. Abra **Model**.
2. Escolha o **Agent** (ex.: `alpha`, `beta`) no topo.
3. Em **Register model**, preencha:
   - **provider** — ex.: `zhipu`, `deepseek`, `openai`.
   - **model_name** — o `model_name` do picoclaw (ex.: `glm-4.7`).
   - **litellm model** — o id do modelo no provedor (frequentemente igual ao `model_name`).
   - **api_base** — a URL base do provedor (ex.: `https://open.bigmodel.cn/api/paas/v4`).
   - **api_key** — write-only; guardada no servidor, nunca devolvida.
4. **Register.** O modelo entra no registry daquele agente.

Modelos registrados são **por agente e globais ao agente** — a mesma lista fica
disponível para atribuir a qualquer usuário daquele agente.

### 5.2 Atribuir um modelo a um usuário

Na lista de usuários (usuários do agente selecionado), escolha um modelo
registrado e **Apply** para um usuário. O proxy grava a entrada do modelo —
incluindo a `api_key` — no `config.json` do picoclaw daquele usuário, então o
agente dele passa a autenticar com o modelo atribuído no próximo turno.

> Um usuário recém-provisionado começa no modelo **default** do agente, fixado
> em `crab/crab-shell-proxy/config.yaml` (com a chave do ambiente). Atribuir um
> modelo registrado aqui **sobrescreve** isso para aquele usuário específico.

### 5.3 Remover um modelo

Exclua um modelo registrado do registry do agente pela ação de delete. Usuários
já atribuídos mantêm o `config.json` atual até serem reatribuídos.

---

## 6. Members (membros)

A aba **Members** lista os usuários da **subscription** selecionada, agrupados
por agente (role). Use para ver quem existe por agente antes de atribuir modelos
(seção 5) ou revisar material compartilhado. Um escopo **tenant** não tem lista
de membros (membros vivem no nível de subscription).

---

## 7. Branding

Branding global da instância (o logo mostrado como avatar do tenant na sidebar
do chat). Essa aba é **staff-only** e não é por-escopo.

---

## 8. Como roles liberam acesso a um agente

Alcançar um agente é uma questão do **mycelium**, não do chat-webapp. As rotas
do gateway são `protectedByRoles` (roles `alpha` / `beta`), então uma conta
precisa ter a guest-role correspondente para falar com aquele agente. Roles são
atribuídas no **mycelium-webapp** (a UI de admin do próprio Mycelium) pelo fluxo
Staff → tenant → subscription → guest-invite. Quando o usuário tem a role, ele
aparece em **Members** (seção 6) e pode receber a atribuição de um modelo.
