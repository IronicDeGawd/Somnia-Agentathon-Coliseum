// CORS proxy for dreamDEX REST orderbook.
// Browser fetch to api.dreamdex.io is blocked; this server route fetches it
// on the user's behalf so the swap UI can read the SOMI/USDso best bid.
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const res = await fetch(
      'https://api.dreamdex.io/v0/orderbooks?symbols=SOMI:USDso',
      { cache: 'no-store' },
    );
    if (!res.ok) {
      return Response.json({ error: `dreamDEX REST ${res.status}` }, { status: 502 });
    }
    const data = await res.json();
    return Response.json(data, {
      headers: { 'cache-control': 'no-store, max-age=0' },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 502 });
  }
}
