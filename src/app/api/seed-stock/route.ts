import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// One-time endpoint to seed stock items from PDF
// DELETE THIS FILE after use!
export async function GET() {
  try {
    const items = [
      // ── SUPRIMENTOS (Compras) ──
      { name: "Pães", category: "SUPRIMENTOS", quantity: 15 },
      { name: "Rosquinhas Salgada/Doce", category: "SUPRIMENTOS", quantity: 16 },
      { name: "Leite", category: "SUPRIMENTOS", quantity: 12 },
      { name: "Tang", category: "SUPRIMENTOS", quantity: 50 },
      { name: "Açúcar", category: "SUPRIMENTOS", quantity: 10 },
      { name: "Café", category: "SUPRIMENTOS", quantity: 6 },
      { name: "Cuscuz", category: "SUPRIMENTOS", quantity: 8 },
      { name: "Macarrão N°8", category: "SUPRIMENTOS", quantity: 8 },
      { name: "Molho de Tomate", category: "SUPRIMENTOS", quantity: 10 },
      { name: "Óleo", category: "SUPRIMENTOS", quantity: 5 },
      { name: "Vinagre", category: "SUPRIMENTOS", quantity: 2 },
      { name: "Farinha de Trigo", category: "SUPRIMENTOS", quantity: 1 },
      { name: "Papel Higiênico", category: "SUPRIMENTOS", quantity: 1 },
      { name: "Esponja", category: "SUPRIMENTOS", quantity: 1 },
      { name: "Bombril", category: "SUPRIMENTOS", quantity: 1 },
      { name: "Detergente", category: "SUPRIMENTOS", quantity: 4 },
      { name: "Sal", category: "SUPRIMENTOS", quantity: 2 },
      { name: "Farinha de Mandioca", category: "SUPRIMENTOS", quantity: 2 },
      { name: "Feijão", category: "SUPRIMENTOS", quantity: 15 },
      { name: "Arroz", category: "SUPRIMENTOS", quantity: 30 },
      { name: "Colorífico", category: "SUPRIMENTOS", quantity: 1 },
      { name: "Sazon", category: "SUPRIMENTOS", quantity: 3 },
      { name: "Margarina", category: "SUPRIMENTOS", quantity: 2 },
      { name: "Água", category: "SUPRIMENTOS", quantity: 30 },

      // ── CARNE ──
      { name: "Salsicha", category: "CARNE", quantity: 2 },
      { name: "Coxa e Sobre Coxa", category: "CARNE", quantity: 10 },
      { name: "Peito de Frango S/Osso", category: "CARNE", quantity: 10 },
      { name: "Acém/Paleta", category: "CARNE", quantity: 10 },
      { name: "Carnes p/ Bife", category: "CARNE", quantity: 10 },
      { name: "Bisteca", category: "CARNE", quantity: 5 },
      { name: "Calabresa", category: "CARNE", quantity: 5 },
      { name: "Cx de Hambúrguer", category: "CARNE", quantity: 2 },

      // ── FEIRA ──
      { name: "Repolho", category: "FEIRA", quantity: 4 },
      { name: "Pimentão", category: "FEIRA", quantity: 1 },
      { name: "Laranja", category: "FEIRA", quantity: 10 },
      { name: "Batata", category: "FEIRA", quantity: 5 },
      { name: "Beterraba", category: "FEIRA", quantity: 3 },
      { name: "Ovos", category: "FEIRA", quantity: 90 },
      { name: "Cebola", category: "FEIRA", quantity: 4 },
      { name: "Alho", category: "FEIRA", quantity: 20 },
      { name: "Tomate", category: "FEIRA", quantity: 4 },
    ];

    const created = [];

    for (const item of items) {
      const record = await prisma.stockItem.create({
        data: {
          name: item.name,
          category: item.category as any,
          quantity: item.quantity,
          default_quantity: item.quantity,
          updated_by: "Sistema",
        },
      });
      created.push({ id: record.id, name: record.name, category: record.category, qty: record.quantity });
    }

    return NextResponse.json({
      success: true,
      message: `${created.length} itens adicionados ao estoque`,
      items: created,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
