"""
Gerador da apresentacao comercial do Cargo Stock.
Saida: apresentacao_cargo_stock.pdf (16:9, slides para projetar)
"""
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor, Color
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

# Dimensoes 16:9 (960 x 540 pt) - confortavel para projecao
W, H = 960, 540

# Paleta corporativa maritima
NAVY = HexColor("#0A2342")
NAVY_SOFT = HexColor("#1E3D59")
NAVY_LIGHT = HexColor("#2E5266")
GOLD = HexColor("#F5B700")
GOLD_SOFT = HexColor("#E8A317")
ORANGE = HexColor("#E8871E")
TEXT_DARK = HexColor("#1A2332")
TEXT_MID = HexColor("#4A5568")
TEXT_LIGHT = HexColor("#718096")
BG_LIGHT = HexColor("#F7F9FC")
BG_CARD = HexColor("#FFFFFF")
BORDER = HexColor("#E2E8F0")
GREEN = HexColor("#2F855A")
RED = HexColor("#C53030")
WHITE = HexColor("#FFFFFF")

OUTPUT = r"C:\Users\Guilherme\Documents\Git\cargo_stock\apresentacao\apresentacao_cargo_stock.pdf"

# ============================================================
# HELPERS DE DESENHO
# ============================================================

def fill_bg(c, color=BG_LIGHT):
    c.setFillColor(color)
    c.rect(0, 0, W, H, stroke=0, fill=1)

def header_bar(c, page_num, total, section=""):
    # Faixa superior
    c.setFillColor(NAVY)
    c.rect(0, H - 32, W, 32, stroke=0, fill=1)
    # Logo / marca
    c.setFillColor(GOLD)
    c.rect(20, H - 24, 14, 14, stroke=0, fill=1)
    c.setFillColor(WHITE)
    c.setFont("Helvetica-Bold", 11)
    c.drawString(42, H - 21, "CARGO STOCK")
    c.setFillColor(GOLD)
    c.setFont("Helvetica", 9)
    c.drawString(130, H - 21, "Sistema de Gestao Portuaria")
    # Section name (direita)
    if section:
        c.setFillColor(WHITE)
        c.setFont("Helvetica", 9)
        c.drawRightString(W - 20, H - 21, section.upper())

def footer_bar(c, page_num, total):
    # Linha
    c.setStrokeColor(BORDER)
    c.setLineWidth(0.5)
    c.line(40, 28, W - 40, 28)
    # Texto
    c.setFillColor(TEXT_LIGHT)
    c.setFont("Helvetica", 8)
    c.drawString(40, 14, "Cargo Stock | Apresentacao Comercial 2026")
    c.drawRightString(W - 40, 14, f"{page_num} / {total}")

def slide_title(c, title, subtitle=None, y=H - 90):
    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 28)
    c.drawString(50, y, title)
    if subtitle:
        c.setFillColor(GOLD)
        c.setFont("Helvetica", 14)
        c.drawString(50, y - 24, subtitle)
    # Underline
    c.setFillColor(GOLD)
    c.rect(50, y - 8, 60, 3, stroke=0, fill=1)

def card(c, x, y, w, h, fill=BG_CARD, border=BORDER, radius=8):
    c.setFillColor(fill)
    c.setStrokeColor(border)
    c.setLineWidth(0.8)
    c.roundRect(x, y, w, h, radius, stroke=1, fill=1)

def icon_box(c, x, y, size, color, letter):
    c.setFillColor(color)
    c.roundRect(x, y, size, size, 6, stroke=0, fill=1)
    c.setFillColor(WHITE)
    c.setFont("Helvetica-Bold", size * 0.55)
    # Centraliza letra
    tw = c.stringWidth(letter, "Helvetica-Bold", size * 0.55)
    c.drawString(x + (size - tw) / 2, y + size * 0.28, letter)

def bullet(c, x, y, text, color=NAVY, size=11):
    c.setFillColor(color)
    c.circle(x + 4, y + 4, 3, stroke=0, fill=1)
    c.setFillColor(TEXT_DARK)
    c.setFont("Helvetica", size)
    c.drawString(x + 14, y, text)

def wrap_text(c, text, x, y, max_width, font="Helvetica", size=11, leading=14, color=TEXT_DARK):
    """Quebra texto em linhas e desenha."""
    c.setFillColor(color)
    c.setFont(font, size)
    words = text.split()
    line = ""
    cy = y
    for word in words:
        test = (line + " " + word).strip()
        if c.stringWidth(test, font, size) <= max_width:
            line = test
        else:
            c.drawString(x, cy, line)
            cy -= leading
            line = word
    if line:
        c.drawString(x, cy, line)
    return cy

# ============================================================
# SLIDES
# ============================================================

def slide_cover(c, page_num, total):
    # Background navy gradient simulado
    c.setFillColor(NAVY)
    c.rect(0, 0, W, H, stroke=0, fill=1)
    # Faixa lateral dourada
    c.setFillColor(GOLD)
    c.rect(0, 0, 8, H, stroke=0, fill=1)
    # Faixa decorativa diagonal-ish (retangulo no canto)
    c.setFillColor(NAVY_SOFT)
    c.rect(W - 280, 0, 280, H, stroke=0, fill=1)
    c.setFillColor(GOLD)
    c.rect(W - 280, 0, 4, H, stroke=0, fill=1)

    # Onda decorativa - retangulos empilhados no canto
    c.setFillColor(GOLD)
    c.rect(W - 80, H - 80, 30, 8, stroke=0, fill=1)
    c.setFillColor(GOLD_SOFT)
    c.rect(W - 80, H - 95, 50, 8, stroke=0, fill=1)
    c.setFillColor(ORANGE)
    c.rect(W - 80, H - 110, 40, 8, stroke=0, fill=1)

    # Logo / marca
    c.setFillColor(GOLD)
    c.rect(60, H - 130, 36, 36, stroke=0, fill=1)
    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 22)
    c.drawString(72, H - 122, "C")

    # Titulo principal
    c.setFillColor(WHITE)
    c.setFont("Helvetica-Bold", 56)
    c.drawString(60, H - 220, "Cargo Stock")
    # Tagline
    c.setFillColor(GOLD)
    c.setFont("Helvetica-Bold", 22)
    c.drawString(60, H - 255, "Sistema de Gestao para Operacoes Portuarias")
    # Descricao
    c.setFillColor(HexColor("#B0BEC5"))
    c.setFont("Helvetica", 14)
    c.drawString(60, H - 285, "Navios . Equipes . Estoque . Financeiro . Comunicacao")

    # Linha decorativa
    c.setFillColor(GOLD)
    c.rect(60, H - 310, 100, 3, stroke=0, fill=1)

    # Caixa de destaque
    c.setFillColor(NAVY_SOFT)
    c.roundRect(60, 80, 480, 90, 6, stroke=0, fill=1)
    c.setFillColor(GOLD)
    c.setFont("Helvetica-Bold", 12)
    c.drawString(80, 140, "TUDO QUE SUA OPERACAO PRECISA, EM UM SO LUGAR")
    c.setFillColor(WHITE)
    c.setFont("Helvetica", 11)
    c.drawString(80, 118, "Do registro do navio ao fechamento da folha de pagamento,")
    c.drawString(80, 102, "com comunicacao automatica via WhatsApp para sua equipe.")

    # Rodape
    c.setFillColor(HexColor("#90A4AE"))
    c.setFont("Helvetica", 9)
    c.drawString(60, 40, "Apresentacao Comercial . 2026")
    c.drawRightString(W - 60, 40, "Versao 0.2")


def slide_desafio(c, page_num, total):
    fill_bg(c)
    header_bar(c, page_num, total, "Contexto")
    slide_title(c, "O Desafio Operacional", "O dia a dia de quem opera nos portos")

    # 4 cards de problemas
    problems = [
        ("Planilhas espalhadas", "Escala em um arquivo, folha em outro, EPI em um terceiro. Informacao se perde, dado nao bate."),
        ("Comunicacao manual", "Avisar cada colaborador por WhatsApp leva horas. Mensagens se perdem, escala muda, ninguem fica sabendo."),
        ("Folha de pagamento confusa", "Calcular pagamentos com Pluxee, Extra, valores especiais por funcao em planilha e arriscado."),
        ("Sem visao consolidada", "Quantos navios estao em operacao? Quem esta disponivel? Que treinamentos venceram? Sem painel central."),
    ]

    card_w = (W - 100 - 30) / 2
    card_h = 130
    start_y = H - 270
    icons = ["X", "!", "$", "?"]
    icon_colors = [RED, ORANGE, GOLD_SOFT, NAVY_LIGHT]
    for i, (title, desc) in enumerate(problems):
        col = i % 2
        row = i // 2
        x = 50 + col * (card_w + 30)
        y = start_y - row * (card_h + 20)
        card(c, x, y, card_w, card_h)
        icon_box(c, x + 18, y + card_h - 50, 36, icon_colors[i], icons[i])
        c.setFillColor(NAVY)
        c.setFont("Helvetica-Bold", 14)
        c.drawString(x + 68, y + card_h - 30, title)
        wrap_text(c, desc, x + 68, y + card_h - 55, card_w - 80, size=10, leading=13, color=TEXT_MID)

    footer_bar(c, page_num, total)


def slide_solucao(c, page_num, total):
    fill_bg(c)
    header_bar(c, page_num, total, "A Solucao")
    slide_title(c, "Cargo Stock", "Um unico sistema para toda a operacao")

    # Frase central
    c.setFillColor(NAVY_SOFT)
    c.roundRect(50, H - 230, W - 100, 70, 8, stroke=0, fill=1)
    c.setFillColor(WHITE)
    c.setFont("Helvetica-Bold", 18)
    c.drawString(70, H - 195, "Plataforma integrada que conecta navios, equipes, estoque,")
    c.drawString(70, H - 218, "financeiro e WhatsApp em um unico fluxo operacional.")

    # 4 pilares
    pillars = [
        ("Centralizado", "Toda informacao em um banco de dados unico, acessivel por toda equipe."),
        ("Em tempo real", "Mudancas refletem instantaneamente: escala, estoque, financeiro."),
        ("Comunicacao automatica", "Escalou? A equipe ja recebe no WhatsApp, no grupo da operacao."),
        ("Controle por perfil", "Cada usuario ve apenas o que precisa: 6 perfis pre-configurados."),
    ]
    card_w = (W - 100 - 60) / 4
    card_h = 130
    y = 80
    for i, (title, desc) in enumerate(pillars):
        x = 50 + i * (card_w + 20)
        card(c, x, y, card_w, card_h)
        # Top border colored
        c.setFillColor(GOLD)
        c.rect(x, y + card_h - 4, card_w, 4, stroke=0, fill=1)
        c.setFillColor(NAVY)
        c.setFont("Helvetica-Bold", 13)
        c.drawString(x + 14, y + card_h - 28, title)
        wrap_text(c, desc, x + 14, y + card_h - 50, card_w - 28, size=9, leading=12, color=TEXT_MID)

    footer_bar(c, page_num, total)


def slide_modulos(c, page_num, total):
    fill_bg(c)
    header_bar(c, page_num, total, "Visao Geral")
    slide_title(c, "9 Modulos Integrados", "Tudo que sua empresa portuaria precisa")

    modules = [
        ("Dashboard", "Painel executivo", NAVY),
        ("Navios", "Operacoes maritimas", NAVY_SOFT),
        ("Escalacao", "Embarque e Costado", GOLD_SOFT),
        ("Colaboradores", "Pessoal e documentos", NAVY_LIGHT),
        ("Estoque", "Itens e movimentacoes", ORANGE),
        ("Equipamentos", "Ferramentas e maquinas", NAVY),
        ("Financeiro", "Folha e despesas", GOLD),
        ("Solicitacoes", "Compras e fornecedores", NAVY_SOFT),
        ("WhatsApp", "Conversas e mensagens", GREEN),
    ]
    cols = 3
    rows = 3
    margin_x = 50
    gap = 18
    card_w = (W - margin_x * 2 - gap * (cols - 1)) / cols
    card_h = 95
    start_y = H - 200
    for i, (name, desc, color) in enumerate(modules):
        col = i % cols
        row = i // cols
        x = margin_x + col * (card_w + gap)
        y = start_y - row * (card_h + gap)
        card(c, x, y, card_w, card_h)
        icon_box(c, x + 16, y + card_h - 58, 42, color, name[0])
        c.setFillColor(NAVY)
        c.setFont("Helvetica-Bold", 14)
        c.drawString(x + 70, y + card_h - 30, name)
        c.setFillColor(TEXT_MID)
        c.setFont("Helvetica", 10)
        c.drawString(x + 70, y + card_h - 48, desc)

    footer_bar(c, page_num, total)


def slide_dashboard(c, page_num, total):
    fill_bg(c)
    header_bar(c, page_num, total, "Modulo 1 . Dashboard")
    slide_title(c, "Painel Executivo", "Visao 360 da operacao em uma tela")

    # Lado esquerdo: lista de KPIs
    items = [
        ("Estoque total e itens em estoque baixo"),
        ("Colaboradores ativos por status"),
        ("Ferramentas e EPIs disponiveis"),
        ("Navios em operacao no momento"),
        ("Previsao de embarques (grafico anual)"),
        ("Treinamentos vencendo (NR-1, NR-6, etc.)"),
        ("Aniversariantes do mes"),
        ("Cotacao do dolar em tempo real"),
        ("Ultimos logins da equipe"),
        ("Solicitacoes pendentes"),
    ]
    x = 50
    y = H - 200
    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 14)
    c.drawString(x, y + 20, "O que voce ve assim que entra:")
    for i, item in enumerate(items):
        bullet(c, x, y - i * 22, item, color=GOLD, size=11)

    # Lado direito: card destaque
    card_x = 560
    card_y = 70
    card_w = W - card_x - 50
    card_h = H - 130
    card(c, card_x, card_y, card_w, card_h, fill=NAVY)
    c.setFillColor(GOLD)
    c.setFont("Helvetica-Bold", 14)
    c.drawString(card_x + 20, card_y + card_h - 30, "DECISOES MAIS RAPIDAS")
    c.setFillColor(WHITE)
    c.setFont("Helvetica", 11)
    lines = [
        "Sem precisar abrir 5 planilhas",
        "para saber:",
        "",
        ". Quantos navios estao operando",
        ". Quem esta disponivel pra embarcar",
        ". Que treinamento vai vencer",
        ". Quanto custou a operacao do mes",
        "",
        "Tudo num clique, atualizado",
        "em tempo real.",
    ]
    for i, line in enumerate(lines):
        c.drawString(card_x + 20, card_y + card_h - 60 - i * 18, line)

    footer_bar(c, page_num, total)


def slide_navios(c, page_num, total):
    fill_bg(c)
    header_bar(c, page_num, total, "Modulo 2 . Navios")
    slide_title(c, "Navios e Operacoes", "Registro completo de cada navio que atende sua empresa")

    # Coluna esquerda: features
    features = [
        ("Cadastro completo", "Nome, chegada, partida, porto, cliente, tipo de carga e porões."),
        ("Status em tempo real", "Agendado . Em Operacao . Concluido . Cancelado."),
        ("Tipo de servico", "Lavagem de porao, pintura, raspagem ou costado."),
        ("Equipe designada", "Vincule a equipe responsavel ao navio."),
        ("Grupo WhatsApp", "Associe o JID do grupo da operacao - escalacoes sincronizadas automaticamente."),
    ]
    x = 50
    y = H - 180
    for i, (title, desc) in enumerate(features):
        bullet(c, x, y - i * 50 + 8, title, color=GOLD)
        c.setFillColor(TEXT_MID)
        c.setFont("Helvetica", 10)
        wrap_text(c, desc, x + 14, y - i * 50 - 8, 420, size=10, leading=12, color=TEXT_MID)

    # Coluna direita: atalho destaque
    card_x = 540
    card_y = 90
    card_w = W - card_x - 50
    card_h = 290
    card(c, card_x, card_y, card_w, card_h, fill=NAVY)
    c.setFillColor(GOLD)
    c.setFont("Helvetica-Bold", 13)
    c.drawString(card_x + 20, card_y + card_h - 30, "ATALHO EXCLUSIVO")
    c.setFillColor(WHITE)
    c.setFont("Helvetica-Bold", 16)
    c.drawString(card_x + 20, card_y + card_h - 60, "Escalar toda a Equipe")
    c.setFillColor(HexColor("#B0BEC5"))
    c.setFont("Helvetica", 11)
    box_lines = [
        "Um clique no modal de cadastro",
        "do navio e o sistema escala",
        "automaticamente todos os",
        "colaboradores ativos da equipe.",
        "",
        "Economize 30 min por operacao",
        "que antes eram preenchidos",
        "linha por linha em planilha.",
    ]
    for i, line in enumerate(box_lines):
        c.drawString(card_x + 20, card_y + card_h - 90 - i * 18, line)

    footer_bar(c, page_num, total)


def slide_escalacao(c, page_num, total):
    fill_bg(c)
    header_bar(c, page_num, total, "Modulo 3 . Escalacao")
    slide_title(c, "Escalacao Inteligente", "Dois fluxos pensados para operacao real")

    # 3 cards lado a lado: Embarque, Costado, Estoque
    cards_data = [
        ("EMBARQUE", "Equipe a bordo",
         ["Selecione colaboradores por funcao",
          "Defina taxa diaria, Pluxee e Extra",
          "Sistema avisa quem ja esta ocupado",
          "Sincroniza no grupo WhatsApp",
          "Auditoria: quem adicionou, quando"]),
        ("COSTADO", "Trabalho de manutencao",
         ["4 turnos fixos: 07-13, 13-19, 19-01, 01-07",
          "Alocacao por turno e data",
          "Marca turnos nao-requisitados",
          "Mensagem com @mention no grupo",
          "Porto fixo em Santos"]),
        ("ESTOQUE", "Itens para a operacao",
         ["Aloque itens de estoque para o Job",
          "Defina quantidade e validade",
          "Registro historico de consumo",
          "Rastreio por operacao",
          "Integracao com modulo Estoque"]),
    ]

    card_w = (W - 100 - 40) / 3
    card_h = 280
    y = 80
    for i, (head, sub, items) in enumerate(cards_data):
        x = 50 + i * (card_w + 20)
        card(c, x, y, card_w, card_h, fill=BG_CARD)
        # Top bar
        c.setFillColor(GOLD if i == 0 else (NAVY_SOFT if i == 1 else ORANGE))
        c.rect(x, y + card_h - 50, card_w, 50, stroke=0, fill=1)
        c.setFillColor(WHITE)
        c.setFont("Helvetica-Bold", 16)
        c.drawString(x + 16, y + card_h - 25, head)
        c.setFont("Helvetica", 10)
        c.drawString(x + 16, y + card_h - 40, sub)
        # Items
        for j, item in enumerate(items):
            iy = y + card_h - 80 - j * 30
            c.setFillColor(GOLD)
            c.circle(x + 22, iy + 4, 3, stroke=0, fill=1)
            c.setFillColor(TEXT_DARK)
            c.setFont("Helvetica", 9)
            wrap_text(c, item, x + 32, iy + 2, card_w - 50, size=9, leading=11, color=TEXT_DARK)

    footer_bar(c, page_num, total)


def slide_colaboradores(c, page_num, total):
    fill_bg(c)
    header_bar(c, page_num, total, "Modulo 4 . Colaboradores")
    slide_title(c, "Gestao de Pessoal", "Tudo sobre cada colaborador, num so lugar")

    # 4 colunas de informacoes
    blocks = [
        ("Dados pessoais", ["Nome, CPF, RG, telefone", "Dados bancarios", "Endereco e contato"]),
        ("Vinculo laboral", ["Status, setor, funcao", "Salario e data admissao", "Tipo de contrato"]),
        ("Documentos", ["Vacinacao, CNH, ISPS", "ASO com data e status", "E-Social e submódulo"]),
        ("Treinamentos", ["NR-1, NR-6, NR-7", "Salva-vidas, bota borracha", "Alertas de vencimento"]),
    ]
    col_w = (W - 100 - 60) / 4
    col_h = 180
    y = H - 270
    for i, (title, items) in enumerate(blocks):
        x = 50 + i * (col_w + 20)
        card(c, x, y, col_w, col_h)
        c.setFillColor(NAVY)
        c.rect(x, y + col_h - 4, col_w, 4, stroke=0, fill=1)
        c.setFillColor(NAVY)
        c.setFont("Helvetica-Bold", 13)
        c.drawString(x + 14, y + col_h - 28, title)
        for j, it in enumerate(items):
            c.setFillColor(GOLD)
            c.circle(x + 18, y + col_h - 55 - j * 22 + 4, 2, stroke=0, fill=1)
            c.setFillColor(TEXT_DARK)
            c.setFont("Helvetica", 9)
            c.drawString(x + 26, y + col_h - 55 - j * 22, it)

    # Banner inferior: EPIs e Uniformes
    by = 60
    c.setFillColor(NAVY)
    c.roundRect(50, by, W - 100, 60, 6, stroke=0, fill=1)
    c.setFillColor(GOLD)
    c.setFont("Helvetica-Bold", 13)
    c.drawString(70, by + 36, "EPIs e UNIFORMES INTEGRADOS")
    c.setFillColor(WHITE)
    c.setFont("Helvetica", 11)
    c.drawString(70, by + 18, "Entrega, devolucao, controle de tamanhos e estoque - tudo vinculado ao colaborador.")

    footer_bar(c, page_num, total)


def slide_estoque(c, page_num, total):
    fill_bg(c)
    header_bar(c, page_num, total, "Modulo 5 . Estoque e Equipamentos")
    slide_title(c, "Controle Integrado", "Itens, ferramentas, maquinarios e EPIs sob controle")

    # Lado esquerdo: Estoque
    card_x = 50
    card_y = 80
    card_w = (W - 100 - 30) / 2
    card_h = 300
    card(c, card_x, card_y, card_w, card_h)
    c.setFillColor(GOLD)
    c.rect(card_x, card_y + card_h - 50, card_w, 50, stroke=0, fill=1)
    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 16)
    c.drawString(card_x + 20, card_y + card_h - 30, "ESTOQUE")
    c.setFont("Helvetica", 11)
    c.drawString(card_x + 20, card_y + card_h - 44, "Suprimentos, Carnes, Feira")

    items = [
        "CRUD completo de itens",
        "Categorias organizadas",
        "Estoque por equipe (1, 2, 3)",
        "Movimentacoes: ENTRADA, BAIXA, AJUSTE",
        "Quantidade minima com alerta",
        "Validade de cada item",
        "Historico completo auditavel",
    ]
    for i, it in enumerate(items):
        iy = card_y + card_h - 80 - i * 26
        c.setFillColor(GOLD)
        c.circle(card_x + 25, iy + 4, 3, stroke=0, fill=1)
        c.setFillColor(TEXT_DARK)
        c.setFont("Helvetica", 10)
        c.drawString(card_x + 35, iy, it)

    # Lado direito: Equipamentos
    card_x = 50 + card_w + 30
    card(c, card_x, card_y, card_w, card_h)
    c.setFillColor(NAVY)
    c.rect(card_x, card_y + card_h - 50, card_w, 50, stroke=0, fill=1)
    c.setFillColor(GOLD)
    c.setFont("Helvetica-Bold", 16)
    c.drawString(card_x + 20, card_y + card_h - 30, "EQUIPAMENTOS")
    c.setFillColor(WHITE)
    c.setFont("Helvetica", 11)
    c.drawString(card_x + 20, card_y + card_h - 44, "Ferramentas e Maquinarios")

    items = [
        "Ferramentas e maquinarios separados",
        "Status: Disponivel, Equipe 1, 2, Manutencao",
        "Emprestar para equipe",
        "Devolucao registrada",
        "Envio para manutencao",
        "Localizacao e notas por item",
        "Historico das ultimas 50 movimentacoes",
    ]
    for i, it in enumerate(items):
        iy = card_y + card_h - 80 - i * 26
        c.setFillColor(NAVY)
        c.circle(card_x + 25, iy + 4, 3, stroke=0, fill=1)
        c.setFillColor(TEXT_DARK)
        c.setFont("Helvetica", 10)
        c.drawString(card_x + 35, iy, it)

    footer_bar(c, page_num, total)


def slide_financeiro(c, page_num, total):
    fill_bg(c)
    header_bar(c, page_num, total, "Modulo 6 . Financeiro")
    slide_title(c, "Folha de Pagamento e Custos", "Calculo automatico de pagamentos com auditoria completa")

    # Lado esquerdo
    x = 50
    y = H - 180
    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 14)
    c.drawString(x, y + 30, "O que o modulo entrega:")
    items = [
        ("Funcoes e valores", "Cadastre cada funcao operacional (WAP, Ajudante, etc.) com unidade (por porao, dia, hora) e valor padrao."),
        ("Historico de tarifas", "Toda mudanca de valor fica registrada - acompanhe a evolucao de salarios ao longo do tempo."),
        ("Valor por colaborador", "Sobrescreva o valor padrao para colaboradores antigos ou especiais."),
        ("Pluxee e Extra", "Rateie pagamentos entre Pluxee (cartao beneficio) e Extra (rateio de operacoes)."),
        ("Despesas categorizadas", "Compras, Quimica, Material Danificado, Ajuda de Custo, Alimentacao, Restaurante e Outros."),
    ]
    for i, (title, desc) in enumerate(items):
        iy = y - i * 50
        bullet(c, x, iy + 8, title, color=GOLD, size=11)
        wrap_text(c, desc, x + 14, iy - 6, 440, size=9, leading=11, color=TEXT_MID)

    # Lado direito
    card_x = 540
    card_y = 80
    card_w = W - card_x - 50
    card_h = 290
    card(c, card_x, card_y, card_w, card_h, fill=NAVY)
    c.setFillColor(GOLD)
    c.setFont("Helvetica-Bold", 13)
    c.drawString(card_x + 20, card_y + card_h - 30, "FLUXO DE PAGAMENTO")
    flow = [
        ("1.", "Job criado", "Vinculado ao navio e datas"),
        ("2.", "Alocacoes", "Cada colaborador com taxa"),
        ("3.", "Despesas", "Registradas durante operacao"),
        ("4.", "Conferencia", "Supervisor valida (auditavel)"),
        ("5.", "Planilha Excel", "Gerada formatada pra contabilidade"),
        ("6.", "Fechado", "Status = FECHADO, pago"),
    ]
    for i, (n, t, d) in enumerate(flow):
        iy = card_y + card_h - 70 - i * 33
        c.setFillColor(GOLD)
        c.setFont("Helvetica-Bold", 13)
        c.drawString(card_x + 20, iy, n)
        c.setFillColor(WHITE)
        c.setFont("Helvetica-Bold", 11)
        c.drawString(card_x + 42, iy, t)
        c.setFillColor(HexColor("#B0BEC5"))
        c.setFont("Helvetica", 9)
        c.drawString(card_x + 42, iy - 13, d)

    footer_bar(c, page_num, total)


def slide_whatsapp(c, page_num, total):
    fill_bg(c)
    header_bar(c, page_num, total, "Modulo 7 . WhatsApp")
    slide_title(c, "WhatsApp Integrado", "Comunicacao automatica com a equipe")

    # Banner principal
    c.setFillColor(GREEN)
    c.roundRect(50, H - 230, W - 100, 60, 6, stroke=0, fill=1)
    c.setFillColor(WHITE)
    c.setFont("Helvetica-Bold", 16)
    c.drawString(70, H - 200, "Escalou no sistema, a equipe ja recebe no WhatsApp.")
    c.setFont("Helvetica", 11)
    c.drawString(70, H - 220, "Sem precisar copiar nomes em planilha e mandar manualmente para cada um.")

    # 3 cards
    items = [
        ("Conversas",
         "Historico completo de mensagens trocadas. Individuais e grupos. Suporte a texto, imagem, audio, video e documento."),
        ("Mensagens",
         "Envie mensagens diretas para colaboradores ou grupos pelo sistema, sem sair da plataforma."),
        ("Configuracao",
         "Diagnostico de instancias, gestao de grupos, webhooks e logs de sincronizacao."),
    ]
    card_w = (W - 100 - 40) / 3
    card_h = 200
    y = 80
    for i, (title, desc) in enumerate(items):
        x = 50 + i * (card_w + 20)
        card(c, x, y, card_w, card_h)
        c.setFillColor(GREEN)
        c.rect(x, y + card_h - 4, card_w, 4, stroke=0, fill=1)
        icon_box(c, x + 18, y + card_h - 60, 36, GREEN, "W")
        c.setFillColor(NAVY)
        c.setFont("Helvetica-Bold", 14)
        c.drawString(x + 18, y + card_h - 84, title)
        wrap_text(c, desc, x + 18, y + card_h - 105, card_w - 36, size=10, leading=13, color=TEXT_MID)

    footer_bar(c, page_num, total)


def slide_acesso(c, page_num, total):
    fill_bg(c)
    header_bar(c, page_num, total, "Seguranca")
    slide_title(c, "Acesso por Perfil", "6 perfis pre-configurados, cada um ve apenas o que precisa")

    roles = [
        ("GESTOR", "Tudo exceto financeiro", NAVY),
        ("EXECUTIVO", "Tudo + financeiro (so leitura)", NAVY_SOFT),
        ("FINANCEIRO", "Financeiro completo, navios, solicitacoes", GOLD),
        ("RH", "Dashboard, EPIs, navios, mensagens", ORANGE),
        ("MANUTENCAO", "Estoque, ferramentas, EPIs, solicitacoes", NAVY_LIGHT),
        ("TECNOLOGIA", "Super-usuario + WhatsApp config", GREEN),
    ]
    cols = 3
    rows = 2
    card_w = (W - 100 - 40) / 3
    card_h = 130
    start_y = H - 200
    for i, (name, desc, color) in enumerate(roles):
        col = i % cols
        row = i // cols
        x = 50 + col * (card_w + 20)
        y = start_y - row * (card_h + 20)
        card(c, x, y, card_w, card_h)
        # Side stripe
        c.setFillColor(color)
        c.rect(x, y, 6, card_h, stroke=0, fill=1)
        c.setFillColor(color)
        c.setFont("Helvetica-Bold", 16)
        c.drawString(x + 22, y + card_h - 30, name)
        c.setFillColor(TEXT_MID)
        c.setFont("Helvetica", 10)
        wrap_text(c, desc, x + 22, y + card_h - 55, card_w - 40, size=10, leading=12, color=TEXT_MID)
        c.setFillColor(GOLD)
        c.setFont("Helvetica", 8)
        c.drawString(x + 22, y + 14, "ACESSO CONTROLADO")

    footer_bar(c, page_num, total)


def slide_disponibilidade(c, page_num, total):
    fill_bg(c)
    header_bar(c, page_num, total, "Disponibilidade")
    slide_title(c, "Onde Voce Usa", "Acesso de qualquer lugar, da forma que preferir")

    # 2 grandes cards
    items = [
        ("WEB", "Navegador",
         ["Funciona em qualquer navegador",
          "Acesse de qualquer computador",
          "Sem instalacao, sempre atualizado",
          "Compativel com Windows, Mac, Linux",
          "Tambem responsivo em tablet"]),
        ("DESKTOP", "Windows .exe",
         ["Aplicativo nativo para Windows",
          "Instale uma vez, abra do desktop",
          "Mesma interface, mais agil",
          "Funciona em rede local da empresa",
          "Empacotado via Electron"]),
    ]
    card_w = (W - 100 - 40) / 2
    card_h = 280
    y = 80
    for i, (badge, sub, feats) in enumerate(items):
        x = 50 + i * (card_w + 40)
        card(c, x, y, card_w, card_h)
        # Top
        c.setFillColor(NAVY if i == 0 else GOLD)
        c.rect(x, y + card_h - 70, card_w, 70, stroke=0, fill=1)
        c.setFillColor(GOLD if i == 0 else NAVY)
        c.setFont("Helvetica-Bold", 28)
        c.drawString(x + 20, y + card_h - 40, badge)
        c.setFillColor(WHITE if i == 0 else NAVY)
        c.setFont("Helvetica", 12)
        c.drawString(x + 20, y + card_h - 60, sub)
        for j, f in enumerate(feats):
            iy = y + card_h - 100 - j * 28
            c.setFillColor(GOLD)
            c.circle(x + 26, iy + 4, 3, stroke=0, fill=1)
            c.setFillColor(TEXT_DARK)
            c.setFont("Helvetica", 11)
            c.drawString(x + 36, iy, f)

    footer_bar(c, page_num, total)


def slide_diferenciais(c, page_num, total):
    fill_bg(c)
    header_bar(c, page_num, total, "Por que Cargo Stock")
    slide_title(c, "Diferenciais", "O que torna o Cargo Stock diferente de planilhas e sistemas genericos")

    items = [
        ("Especialista em portos",
         "Nao e um ERP generico adaptado. Foi feito para a operacao real - costado, embarque, turnos, porao - falando a sua linguagem."),
        ("WhatsApp embarcado",
         "A unica plataforma do setor com sincronizacao automatica de escala para grupo de WhatsApp - economia de horas por operacao."),
        ("Folha de pagamento sob medida",
         "Pluxee, Extra, valor por porao, valor especial por colaborador. Tudo o que sua contabilidade pede, em planilha pronta."),
        ("Auditoria de tudo",
         "Quem cadastrou? Quem alterou? Quando? Tudo registrado. Para quando alguem pergunta - voce tem a resposta."),
        ("Pronto pra crescer",
         "Stack moderna (Next.js, PostgreSQL, Railway). Conforme sua empresa cresce, o sistema acompanha sem reescrita."),
    ]
    x = 50
    y = H - 180
    for i, (title, desc) in enumerate(items):
        iy = y - i * 56
        # Numero grande
        c.setFillColor(GOLD)
        c.setFont("Helvetica-Bold", 28)
        c.drawString(x, iy - 6, f"0{i+1}")
        c.setFillColor(NAVY)
        c.setFont("Helvetica-Bold", 14)
        c.drawString(x + 50, iy + 8, title)
        wrap_text(c, desc, x + 50, iy - 8, W - 150, size=10, leading=13, color=TEXT_MID)

    footer_bar(c, page_num, total)


def slide_fechamento(c, page_num, total):
    # Background navy
    c.setFillColor(NAVY)
    c.rect(0, 0, W, H, stroke=0, fill=1)
    # Faixa
    c.setFillColor(GOLD)
    c.rect(0, H - 8, W, 8, stroke=0, fill=1)
    c.rect(0, 0, W, 8, stroke=0, fill=1)
    # Lateral
    c.setFillColor(NAVY_SOFT)
    c.rect(W - 220, 0, 220, H, stroke=0, fill=1)
    c.setFillColor(GOLD)
    c.rect(W - 220, 0, 4, H, stroke=0, fill=1)

    # Marca
    c.setFillColor(GOLD)
    c.rect(60, H - 130, 36, 36, stroke=0, fill=1)
    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 22)
    c.drawString(72, H - 122, "C")

    # Mensagem central
    c.setFillColor(WHITE)
    c.setFont("Helvetica-Bold", 44)
    c.drawString(60, H - 220, "Vamos conversar?")
    c.setFillColor(GOLD)
    c.setFont("Helvetica-Bold", 18)
    c.drawString(60, H - 255, "Conheca o Cargo Stock na pratica")

    c.setFillColor(HexColor("#B0BEC5"))
    c.setFont("Helvetica", 12)
    lines = [
        "Apresentacao personalizada para sua operacao",
        "Acesso para teste com seus dados reais",
        "Implantacao acompanhada por especialista",
    ]
    for i, line in enumerate(lines):
        c.drawString(60, H - 300 - i * 22, "> " + line)

    # Caixa de contato
    c.setFillColor(NAVY_SOFT)
    c.roundRect(60, 80, 480, 110, 6, stroke=0, fill=1)
    c.setFillColor(GOLD)
    c.setFont("Helvetica-Bold", 12)
    c.drawString(80, 160, "PROXIMO PASSO")
    c.setFillColor(WHITE)
    c.setFont("Helvetica", 14)
    c.drawString(80, 135, "Agende uma demonstracao gratuita")
    c.setFillColor(HexColor("#B0BEC5"))
    c.setFont("Helvetica", 11)
    c.drawString(80, 110, "Vamos mostrar como o sistema se encaixa")
    c.drawString(80, 92, "na rotina da sua empresa portuaria.")

    # Linha decorativa lateral
    c.setFillColor(GOLD)
    c.rect(W - 180, H - 130, 80, 4, stroke=0, fill=1)
    c.rect(W - 180, H - 145, 60, 4, stroke=0, fill=1)
    c.rect(W - 180, H - 160, 40, 4, stroke=0, fill=1)

    c.setFillColor(WHITE)
    c.setFont("Helvetica-Bold", 16)
    c.drawString(W - 180, H - 200, "CARGO")
    c.drawString(W - 180, H - 222, "STOCK")
    c.setFillColor(GOLD)
    c.setFont("Helvetica", 10)
    c.drawString(W - 180, H - 245, "v0.2 . 2026")

    # Rodape final
    c.setFillColor(HexColor("#90A4AE"))
    c.setFont("Helvetica", 9)
    c.drawString(60, 40, "Obrigado pela atencao")
    c.drawRightString(W - 60, 40, "Cargo Stock . Sistema de Gestao Portuaria")


# ============================================================
# MONTAGEM
# ============================================================

SLIDES = [
    slide_cover,           # 1
    slide_desafio,         # 2
    slide_solucao,         # 3
    slide_modulos,         # 4
    slide_dashboard,       # 5
    slide_navios,          # 6
    slide_escalacao,       # 7
    slide_colaboradores,   # 8
    slide_estoque,         # 9
    slide_financeiro,      # 10
    slide_whatsapp,        # 11
    slide_acesso,          # 12
    slide_disponibilidade, # 13
    slide_diferenciais,    # 14
    slide_fechamento,      # 15
]

def build():
    c = canvas.Canvas(OUTPUT, pagesize=(W, H))
    c.setTitle("Cargo Stock - Apresentacao Comercial")
    c.setAuthor("Cargo Stock")
    c.setSubject("Sistema de Gestao Portuaria")

    total = len(SLIDES)
    for i, slide in enumerate(SLIDES, start=1):
        slide(c, i, total)
        c.showPage()
    c.save()
    print(f"OK: {OUTPUT}")

if __name__ == "__main__":
    build()
