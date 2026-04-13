import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// One-time endpoint to seed stock items from PDF
// Creates items for EQUIPE_1 and EQUIPE_2
// DELETE THIS FILE after use!
export async function GET() {
  try {
    // Clear ALL existing stock items first (and their movements)
    await prisma.stockMovement.deleteMany({});
    await prisma.stockItem.deleteMany({});

    const items = [
      // ── SUPRIMENTOS (Compras + Compras/KG) ──
      { name: "Pães", category: "SUPRIMENTOS", qty: 15 },
      { name: "Rosquinhas Salgada/Doce", category: "SUPRIMENTOS", qty: 16 },
      { name: "Leite", category: "SUPRIMENTOS", qty: 12 },
      { name: "Tang", category: "SUPRIMENTOS", qty: 50 },
      { name: "Açúcar", category: "SUPRIMENTOS", qty: 10 },
      { name: "Café", category: "SUPRIMENTOS", qty: 6 },
      { name: "Cuscuz", category: "SUPRIMENTOS", qty: 8 },
      { name: "Macarrão N°8", category: "SUPRIMENTOS", qty: 8 },
      { name: "Molho de Tomate", category: "SUPRIMENTOS", qty: 10 },
      { name: "Óleo", category: "SUPRIMENTOS", qty: 5 },
      { name: "Vinagre", category: "SUPRIMENTOS", qty: 2 },
      { name: "Farinha de Trigo", category: "SUPRIMENTOS", qty: 1 },
      { name: "Papel Higiênico", category: "SUPRIMENTOS", qty: 1 },
      { name: "Esponja", category: "SUPRIMENTOS", qty: 1 },
      { name: "Bombril", category: "SUPRIMENTOS", qty: 1 },
      { name: "Detergente", category: "SUPRIMENTOS", qty: 4 },
      { name: "Sal", category: "SUPRIMENTOS", qty: 2 },
      { name: "Farinha de Mandioca", category: "SUPRIMENTOS", qty: 2 },
      { name: "Feijão", category: "SUPRIMENTOS", qty: 15 },
      { name: "Arroz", category: "SUPRIMENTOS", qty: 30 },
      { name: "Colorífico", category: "SUPRIMENTOS", qty: 1 },
      { name: "Sazon", category: "SUPRIMENTOS", qty: 3 },
      { name: "Margarina", category: "SUPRIMENTOS", qty: 2 },
      { name: "Água", category: "SUPRIMENTOS", qty: 30 },

      // ── CARNE ──
      { name: "Salsicha", category: "CARNE", qty: 2 },
      { name: "Coxa e Sobre Coxa", category: "CARNE", qty: 10 },
      { name: "Peito de Frango S/Osso", category: "CARNE", qty: 10 },
      { name: "Acém/Paleta", category: "CARNE", qty: 10 },
      { name: "Carnes p/ Bife", category: "CARNE", qty: 10 },
      { name: "Bisteca", category: "CARNE", qty: 5 },
      { name: "Calabresa", category: "CARNE", qty: 5 },
      { name: "Cx de Hambúrguer", category: "CARNE", qty: 2 },

      // ── FEIRA ──
      { name: "Repolho", category: "FEIRA", qty: 4 },
      { name: "Pimentão", category: "FEIRA", qty: 1 },
      { name: "Laranja", category: "FEIRA", qty: 10 },
      { name: "Batata", category: "FEIRA", qty: 5 },
      { name: "Beterraba", category: "FEIRA", qty: 3 },
      { name: "Ovos", category: "FEIRA", qty: 90 },
      { name: "Cebola", category: "FEIRA", qty: 4 },
      { name: "Alho", category: "FEIRA", qty: 20 },
      { name: "Tomate", category: "FEIRA", qty: 4 },
    ];

    const teams = ["EQUIPE_1", "EQUIPE_2"];
    let totalCreated = 0;

    for (const team of teams) {
      // Use createMany for faster bulk insert
      await prisma.stockItem.createMany({
        data: items.map((item) => ({
          name: item.name,
          category: item.category as any,
          quantity: item.qty,
          default_quantity: item.qty,
          team: team,
          min_quantity: 0,
          updated_by: "Sistema",
        })),
      });
      totalCreated += items.length;
    }

    // Verify what was created
    const verify = await prisma.stockItem.groupBy({
      by: ["team"],
      _count: { id: true },
    });

    return NextResponse.json({
      success: true,
      message: `${totalCreated} itens criados (${items.length} por equipe x ${teams.length} equipes). Estoque cheio = Qtd Padrão.`,
      total: totalCreated,
      per_team: items.length,
      verification: verify,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
