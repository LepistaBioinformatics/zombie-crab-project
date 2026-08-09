# Guia do Administrador

Operações do dia-a-dia pela **área de admin do chat-webapp**: injetar arquivos,
segredos e skills compartilhados nos agentes dos usuários, definir os arquivos de
identidade do agente, decidir qual modelo as pessoas recebem, consertar a
configuração das instâncias, convidar membros e definir a marca.

Para *criar* um novo agente, veja [Criando um Agente Customizado](./CREATE_CUSTOM_AGENT.pt-br.md).
Para subir/resetar o stack inteiro, veja o
[README](../README.pt-br.md#rodando-e-resetando-do-zero) na raiz.

---

## 1. Quem administra, e o que você escolhe primeiro

A área de admin fica acessível pelo **chat-webapp** para contas que gerenciam um
**escopo**. Um escopo é:

- **Tenant** — tudo dentro de um tenant.
- **Subscription** — uma conta de subscription dentro de um tenant.

A tela é **agent-first**: você escolhe o agente (`alpha`, `beta`, …)
antes de qualquer tenant ou subscription, porque os agentes vêm da configuração do
proxy deste deploy e existem antes de qualquer tenant. Depois você escolhe o
escopo na trilha lateral, e cada seção age sobre esse par **(agente, escopo)**. As
mudanças descem para os containers dos usuários daquele escopo.

Duas coisas não são seções de agente: **Membros** (a lista de membros pertence a
uma subscription, sejam quais forem os agentes que ela roda) e **Marca**
(instance-wide, só staff).

O modelo mental: você edita material **compartilhado** em um escopo, o proxy
sincroniza numa visão **efetiva**, e o container de cada usuário monta essa visão
como somente-leitura. Um usuário nunca vê o workspace privado de outro — só o
material compartilhado que você injetou no escopo dele.

As seções abaixo têm o nome das abas: **Arquivos · Segredos · Skills ·
Identidade · Modelos · Configuração**, mais **Membros** e **Marca**.

---

## 2. Arquivos

Injete arquivos arbitrários no workspace do agente de cada usuário do escopo.

1. Abra **Arquivos**.
2. Escolha o escopo.
3. Suba os arquivos.

Os agentes dos usuários passam a vê-los no workspace. Use para documentos de
referência, datasets ou qualquer conteúdo estático que os agentes devam ler.

---

## 3. Segredos

Forneça segredos (API keys, tokens, strings de conexão) aos agentes de um escopo
**sem** embuti-los em templates ou imagens.

Formatos suportados:

- **dotenv** — linhas `CHAVE=valor`.
- **json** — um objeto JSON plano de chave/valor.
- **file** — suba um arquivo de segredo como está.

> O formato de segredo **nativo** do picoclaw (a API key do modelo) é
> deliberadamente **indisponível** aqui. Credenciais de modelo são gerenciadas na
> aba **Modelos** (seção 6), não como segredo compartilhado.

Os segredos vão para o store de segredos compartilhados do escopo e são
sincronizados na visão efetiva montada somente-leitura em cada agente.

---

## 4. Skills

Empurre skills (um `SKILL.md` mais arquivos de apoio opcionais) para os agentes de
todos os usuários de um escopo. Uma skill é uma pasta com um `SKILL.md`
(frontmatter YAML `name` + `description`, depois um corpo Markdown) — o mesmo
formato usado em `workspace/skills/<nome>/` de um template.

1. Abra **Skills**, escolha o escopo.
2. Adicione uma skill:
   - escrevendo/editando o `SKILL.md` inline, ou
   - subindo um **zip** da pasta da skill.
3. Arquive ou apague uma skill para removê-la do escopo.

O proxy sincroniza as skills do escopo na visão effective-skills e a monta
somente-leitura em cada agente. Editar uma skill re-sincroniza no lugar (o inode
do mount é preservado, então agentes rodando pegam a mudança).

---

## 5. Identidade (persona)

Os quatro arquivos que o agente lê como identidade, entregues a todo workspace do
par (agente, escopo) selecionado — sobrepondo o template do agente, com o escopo
mais específico vencendo o mais amplo:

| Arquivo | O que é | Como é entregue |
|---|---|---|
| `AGENT.md` | o que o agente faz e como se comporta | **somente-leitura** |
| `SOUL.md` | a voz / personalidade dele | **somente-leitura** |
| `HEARTBEAT.md` | a lista de tarefas recorrentes | **somente-leitura** |
| `USER.md` | o que se sabe sobre o usuário | **só semente** |

O conjunto é **fixo e fechado** — esses endpoints escrevem na raiz de um
workspace, então um nome de arquivo arbitrário seria uma primitiva de escrita
arbitrária alcançando todo container do escopo. O proxy recusa qualquer outro
nome.

- **Arquivos somente-leitura** não podem ser alterados pelo membro no workspace, e
  uma edição não sobrevive a um restart.
- **`USER.md` continua gravável**: o agente registra ali o que aprende sobre o
  usuário. Defini-lo aqui determina de onde um workspace **novo** parte; nunca
  sobrescreve um existente.

Cada linha diz se o arquivo está **definido aqui** ou **herdado**. Abrir o editor
pré-carrega o que o agente realmente roda — resolvido pela cascata (este escopo →
o tenant abaixo → o template do agente) — para você editar uma identidade real em
vez de uma página em branco; **salvar** é o que torna o arquivo deste escopo.
**Limpar** o remove neste escopo e os workspaces voltam ao escopo mais amplo, ou
ao template.

---

## 6. Modelos

Duas coisas separadas: um **inventário** de modelos que o proxy pode servir, e a
**escada** que decide qual deles um workspace resolve.

### 6.1 O inventário (registre uma vez)

Um inventário para o proxy inteiro. Um modelo é registrado uma vez — com as
credenciais — e cada escopo aponta para esse registro em vez de guardar a própria
cópia. Preencha:

- **provider** — ex.: `zhipu`, `deepseek`, `openai`.
- **model_name** — o `model_name` do picoclaw (ex.: `glm-4.7`).
- **litellm model** — o id do modelo no provider (em geral igual ao `model_name`).
- **api_base** — a URL base do provider.
- **api_key** — write-only; guardada no servidor, nunca devolvida.

Os modelos aparecem como **em serviço** ou **aposentados/retidos**; *deprecar* um
modelo o tira de serviço sem apagar o registro.

### 6.2 A escada (quem recebe o quê)

Leia a escada de cima para baixo: cada degrau cobre menos gente que o de cima e o
sobrepõe — degraus instance-wide, depois o tenant, depois a subscription. O
**degrau mais estreito com um modelo vence**, e é nele que um workspace recém
provisionado cai.

Se **nada resolve** para um escopo, novos workspaces ali são **recusados** —
então, antes de limpar o degrau em vigor, verifique o que (se algo) está definido
acima dele. Degraus que você não tem autoridade para ler ficam ocultos; um degrau
instance-wide pode estar cobrindo o escopo mesmo assim.

### 6.3 Pins (uma pessoa)

Um **pin** atribui um modelo registrado a um único usuário e supera todos os
degraus acima. Use para uma pessoa que precisa de algo diferente — para mover um
grupo inteiro, defina o degrau do escopo dela. Pins vivem numa **subscription** (é
onde os usuários estão), e um usuário só aparece depois de ter workspace, isto é,
depois do primeiro chat.

---

## 7. Configuração

Conserto de `config.json` por instância, e edição em massa de uma chave numa
subscription.

- **Em massa** (uma subscription por vez): informe um **caminho pontuado** para um
  valor (ex.: `tools.web.brave.enabled`), **leia primeiro a distribuição atual** —
  o que cada membro tem hoje — e só então escreva. Instâncias cuja chave está
  ausente, bloqueada por um caminho conflitante, ou cujo config está ilegível são
  excluídas da escrita em massa e listadas para conserto individual. Chaves que o
  **proxy possui** (ele as reescreve a cada materialização) são recusadas: uma
  mudança em massa ali não sobreviveria.
- **Instância única**: o editor cru abre o `config.json` de um membro como **JSON**
  formatado ou como **árvore**, valida e grava de volta.

Uma mudança de config vale no próximo start da instância. O controle de restart
no painel decide como essa parada acontece — **agora** (o padrão), **agendada**
para um horário que você escolhe, ou **aviso**: deixada para o membro, que vê o
aviso de restart pendente no chat. A escolha é por sessão, não é armazenada.

---

## 8. Membros

A aba **Membros** lista os usuários da **subscription** selecionada, agrupados por
agente (papel). Dali você pode:

- **Convidar** uma conta para um agente por e-mail, com acesso **read** ou
  **write** (write é o que o chat exige; read é só visualização).
- **Revogar** o acesso de uma conta àquele agente.
- Ver quem existe por agente antes de fixar modelos (seção 6) ou revisar material
  compartilhado.

Um escopo **tenant** não tem lista de membros (membros vivem no nível da
subscription).

---

## 9. Marca

Marca instance-wide: o nome do app, o logo mostrado como avatar do tenant na
sidebar do chat, e o ícone do app. Esta aba é **só para staff** e não é por
escopo.

---

## 10. Como os papéis liberam o acesso a um agente

Alcançar um agente é assunto do **mycelium**. As rotas do gateway são
`protectedByRoles` (um papel por agente: `alpha`, `beta`, …), então
uma conta precisa do guest-role correspondente para falar com aquele agente, com
`write` para o chat em si. Conceder isso é a aba **Membros** acima (que fala com o
mycelium por JSON-RPC no seu lugar) ou o **mycelium-webapp** — a UI de admin do
próprio Mycelium — pelo fluxo Staff → tenant → subscription → guest-invite. Uma
vez com o papel, o usuário aparece em **Membros** e pode receber um pin de modelo.
