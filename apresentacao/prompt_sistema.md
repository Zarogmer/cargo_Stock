# Prompt mestre — Cargo Stock (Cargo Ships Cleaning)

> Cole este texto inteiro no início de qualquer conversa com IA (Claude, ChatGPT, Gemini, NotebookLM) para que ela entenda o sistema e a empresa antes de gerar material. Ao final do prompt, troque o bloco **TAREFA** pelo que você precisa naquela conversa (slides extras, vídeo, copy de site, e-mail comercial, manual de uso, FAQ, post para LinkedIn, roteiro de demo, etc).

---

## CONTEXTO — A empresa

**Nome:** Cargo Ships Cleaning
**Atividade:** Prestação de serviços operacionais a bordo de navios de carga em portos brasileiros (foco em Santos).
**Serviços principais:**
- Lavagem de porão
- Pintura
- Raspagem
- Costado (manutenção e limpeza do casco, em turnos de 6 horas)
- Embarque de equipes para operações de longa duração

**Operação típica:** Navio atraca → empresa monta equipe → equipe embarca ou trabalha no costado em turnos → execução do serviço contratado → fechamento financeiro com o cliente armador.

**Quem trabalha lá:**
- Gestor de operação
- Executivo / dono
- RH
- Financeiro / contabilidade
- Equipe de manutenção (ferramentas, EPI, estoque)
- Tecnologia (suporte ao sistema)
- Colaboradores operacionais (Wapers, Ajudantes, Esfregões, etc.) escalados por operação

---

## O SISTEMA — Cargo Stock

**Cargo Stock** é o ERP próprio da Cargo Ships Cleaning. Substitui o conjunto de planilhas, grupos de WhatsApp soltos e cadernos que a operação usava antes. Centraliza tudo: navios, equipes, escalas, estoque, ferramentas, EPIs, folha de pagamento e comunicação com a equipe.

**Disponibilidade:**
- Web (qualquer navegador, qualquer dispositivo)
- Desktop Windows (.exe via Electron)

**Stack:** Next.js 15 + React 19 + TypeScript + Prisma + PostgreSQL + NextAuth. Hospedado na Railway.

---

## DORES QUE O SISTEMA RESOLVE

1. **Planilhas espalhadas:** escala em um arquivo, folha em outro, EPI em outro. Informação que não bate.
2. **Comunicação manual no WhatsApp:** avisar cada colaborador um a um da escala leva horas e mensagens se perdem.
3. **Folha de pagamento confusa:** cálculos com Pluxee, Extra, valor por porão, valor especial por colaborador feitos manualmente em planilha são arriscados.
4. **Sem visão consolidada:** quantos navios estão operando, quem está disponível, que treinamento venceu — sem painel central, ninguém sabe.
5. **Sem auditoria:** quando alguém pergunta "quem cadastrou isso?" ou "quando essa alteração foi feita?", não há resposta.

---

## MÓDULOS (o que o sistema faz)

### 1. Dashboard executivo
Painel inicial com tudo que importa em uma tela:
- Estoque total e itens em estoque baixo
- Colaboradores por status (ativos, inativos, pendência)
- Ferramentas e EPIs disponíveis
- Navios em operação no momento
- Previsão de embarques do ano (gráfico)
- Treinamentos vencendo (NR-1, NR-6, NR-7, salva-vidas, bota borracha)
- Aniversariantes do mês
- Cotação do dólar
- Últimos logins da equipe

### 2. Navios e operações
- Cadastro de cada navio que atende (nome, chegada, partida, porto, cliente, tipo de carga, quantidade de porões)
- Status do navio: Agendado → Em Operação → Concluído (ou Cancelado)
- Tipo de serviço: lavagem de porão, pintura, raspagem, costado
- Atalho "Escalar toda a Equipe" no cadastro
- Vínculo opcional com grupo de WhatsApp da operação

### 3. Escalação inteligente — três fluxos
**a) Embarque** — equipe que vai a bordo
- Seleciona colaboradores por função (Waper, Ajudante, Esfregão…)
- Define taxa diária, parte em Pluxee, parte em Extra
- Sistema mostra quem já está ocupado (em outra operação)
- Sincroniza no grupo WhatsApp da operação

**b) Costado** — manutenção do casco
- Turnos fixos de 6h: 07-13, 13-19, 19-01, 01-07
- Alocação por turno e por data
- Marcação de turnos não-requisitados
- Porto fixo em Santos
- Sincroniza no grupo com @mention

**c) Estoque para a operação**
- Aloca itens de estoque (consumíveis, química, etc.) para o job
- Define quantidade e validade
- Registra histórico de consumo

### 4. Colaboradores
Cadastro completo de cada funcionário:
- Dados pessoais (nome, CPF, RG, telefone, e-mail, endereço)
- Dados bancários (agência, conta, tipo)
- Vínculo laboral (status, setor, função, salário, data de admissão, contrato)
- Documentos (vacinação, CNH, ISPS, e-Social, ASO com data e status)
- Treinamentos com data (NRs, salva-vidas, bota borracha)
- Tamanhos de EPI/uniforme (bota, camiseta, bermuda)
- Histórico de atualizações

### 5. EPIs e Uniformes
- Cadastro de cada EPI (nome, código CA, tamanho, estoque)
- Entrega registrada para o colaborador
- Devolução registrada
- Mesma estrutura para uniformes

### 6. Estoque
- Categorias: Compras, Carnes, Feira, Suprimentos, Outros
- Estoque por equipe (Equipe 1, Equipe 2, Equipe 3)
- Movimentações: Entrada, Baixa, Ajuste
- Quantidade mínima com alerta no Dashboard
- Validade por item
- Histórico auditável (quem mexeu, quando, por quê)

### 7. Equipamentos (Ferramentas e Maquinários)
- Cadastro separado por tipo
- Status: Disponível, Equipe 1, Equipe 2, Manutenção
- Empréstimo para equipe, devolução, envio para manutenção
- Localização e notas
- Histórico das últimas 50 movimentações

### 8. Financeiro / Folha de pagamento
O coração do controle de custo:
- **Funções cadastradas** (Waper, Ajudante…) com unidade (por porão, dia, hora) e valor padrão
- **Histórico de tarifas:** toda mudança de valor fica registrada
- **Valor por colaborador:** sobrescreve o padrão para casos especiais
- **Pagamento de Embarque:** planilha completa com colaborador, função, dias, valor/porão, Pluxee, Extra, total
- **Pagamento de Costado:** mesma lógica, com turnos por data
- **Despesas categorizadas:** Compras, Química, Material Danificado, Ajuda de Custo, Alimentação, Restaurante, Outros
- **Fluxo:** Aberto → Em Andamento → Verificado → Fechado (pago)
- **Exportação Excel** formatada, pronta para a contabilidade

### 9. WhatsApp integrado (via Evolution API)
- **Conversas:** histórico completo de mensagens (individuais e grupos), com suporte a texto, imagem, áudio, vídeo e documento
- **Mensagens:** envio direto para colaborador ou grupo pelo sistema
- **Configuração:** diagnóstico de instâncias, gestão de grupos, webhooks, logs
- **Sincronização automática:** escalou no sistema, a equipe já recebe no grupo

### 10. Solicitações
- Pedido de ferramenta por colaborador (status: Pendente / Aprovado / Recusado / Comprado)
- Cadastro de fornecedores (nome, contato, categoria, website)
- Links de produtos (URLs para compra rápida)

---

## CONTROLE DE ACESSO (RBAC) — 6 perfis

| Perfil | O que pode fazer |
|--------|------------------|
| **Gestor** | Tudo exceto Financeiro |
| **Executivo** | Tudo + Financeiro em modo leitura |
| **Financeiro** | Financeiro completo, Navios, Solicitações |
| **RH** | Dashboard, EPIs (CRUD), Navios, Mensagens |
| **Manutenção** | Estoque, Ferramentas, EPIs, Solicitações |
| **Tecnologia** | Super-usuário, inclui configuração de WhatsApp |

Cada usuário só enxerga, no menu lateral, os módulos que o seu perfil permite. Nada de "tela vazia" ou botão clicável que dá erro.

---

## FLUXO OPERACIONAL TÍPICO

1. Cliente armador agenda navio.
2. **Cargo Stock:** Navio cadastrado, status = Agendado.
3. Quando o navio chega: status → Em Operação.
4. **Cargo Stock:** Escala montada (Embarque ou Costado).
5. **WhatsApp:** sistema avisa cada colaborador no grupo da operação.
6. Equipe executa o serviço a bordo.
7. **Cargo Stock:** despesas vão sendo registradas (alimentação, química, material).
8. Operação termina: status → Concluído.
9. **Financeiro:** Job verificado pelo supervisor.
10. **Excel exportado** para contabilidade processar a folha.
11. Job fechado: status → Pago.

---

## DIFERENCIAIS

1. **Feito para porto:** fala a linguagem da operação (porão, costado, embarque, turno) — não é ERP genérico adaptado.
2. **WhatsApp embarcado:** sincronização automática da escala economiza horas por operação.
3. **Folha sob medida:** Pluxee + Extra + valor por porão + valor especial por colaborador, do jeito que a contabilidade precisa.
4. **Auditoria de tudo:** cada cadastro e alteração tem autor, data e hora.
5. **Pronto para crescer:** stack moderna (Next.js, PostgreSQL, Railway) que escala junto com a empresa.

---

## TAREFA

> Substitua este bloco pelo que você precisa naquela conversa específica.
> Exemplos:

- "Com base no contexto acima, escreva um **roteiro de vídeo de 90 segundos** para apresentar o Cargo Stock a um novo cliente armador. Tom: profissional, objetivo, brasileiro."
- "Com base no contexto acima, crie uma **copy para a landing page** da Cargo Ships Cleaning, destacando como o sistema garante transparência e controle para o armador contratante."
- "Com base no contexto acima, monte um **roteiro de demonstração ao vivo de 15 minutos** do sistema, listando o que mostrar em cada tela e que perguntas o vendedor deve fazer."
- "Com base no contexto acima, escreva um **e-mail comercial frio** para diretores de armadoras, oferecendo a Cargo Ships Cleaning como prestadora, e mencionando o sistema como diferencial de controle."
- "Com base no contexto acima, gere um **FAQ com 15 perguntas** que clientes finais (armadores) costumam fazer e respostas que destacam o controle do sistema."
- "Com base no contexto acima, escreva um **manual de uso de 2 páginas** para um novo colaborador operacional, explicando como ele vai receber a escala no WhatsApp e o que esperar."
