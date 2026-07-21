import { db } from './../index';
import { nonprofits, investments } from './schema';
import { eq } from 'drizzle-orm';

// Placeholder seed. The real, locally-edited seed (server/db/seed.ts) is
// gitignored and pointed at by SEED_FILE in .env. This file ships in
// place of the real seed so the public repo contains no real data.

async function seed() {
  if (!process.argv.includes('--confirm')) {
    console.error('Error: Seed utility requires --confirm flag to proceed.');
    process.exit(1);
  }
  console.log('Starting database seeding (placeholder)...');

  try {
    const exampleNonprofits = [
      {
        name: 'Example Nonprofit',
        contactEmail: 'contact@example.org',
        grantCycleDates: 'UPDATE to UPDATE',
        grantAmount: 0,
        grantStatus: 'active',
      },
    ];

    for (const np of exampleNonprofits) {
      const existing = await db
        .select()
        .from(nonprofits)
        .where(eq(nonprofits.name, np.name))
        .get();
      if (existing) {
        await db
          .update(nonprofits)
          .set(np)
          .where(eq(nonprofits.id, existing.id));
      } else {
        await db.insert(nonprofits).values(np);
      }
    }

    const exampleTickers = [
      {
        ticker: 'EX1',
        companyName: 'Example Holdings A',
        sector: 'Example',
        shares: 1,
        percentOfAccount: 0.5,
      },
      {
        ticker: 'EX2',
        companyName: 'Example Holdings B',
        sector: 'Example',
        shares: 1,
        percentOfAccount: 0.5,
      },
    ];

    for (const tk of exampleTickers) {
      await db
        .insert(investments)
        .values({
          ticker: tk.ticker,
          companyName: tk.companyName,
          sector: tk.sector,
          shares: tk.shares,
          percentOfAccount: tk.percentOfAccount,
        })
        .onConflictDoUpdate({
          target: investments.ticker,
          set: {
            companyName: tk.companyName,
            sector: tk.sector,
            shares: tk.shares,
            percentOfAccount: tk.percentOfAccount,
          },
        });
    }

    console.log('Seeding complete (placeholder data).');
  } catch (error) {
    console.error('Error seeding database:', error);
    process.exit(1);
  }
}

seed();
