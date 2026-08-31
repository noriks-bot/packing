# Packing — kako aplikacija dobi podatke (stanje 31. 8. 2026)

## Pravilo v eni vrstici
**Metakocka → tabela `orders` v SQLite → stran.** Predpomnilnika ni več v obtoku.

## Kaj polni bazo
`osveziSpremenjena()` (dnevnik: `[ChangeSync]`), vsakih 5 minut:

    query_advance: [{ type: 'last_change_from', value: '2026-08-31T14:00:00+02:00' }]

Metakocko vprašamo **kaj se je spremenilo**, ne kaj je bilo naročeno.
Zato ujame tudi naročilo izpred 25 dni, ki mu je skladišče danes spremenilo status.

- edini veljaven format vrednosti je `2026-08-31T14:00:00+02:00`
  (`2026-08-31`, `...T00:00:00` in `...Z` Metakocka zavrne z „Cannot find value")
- prekrivanje 15 min: če en tek spodleti, ga naslednji pokrije
- ob neuspehu se `lastChangeSyncTs` NE premakne, zato naslednji tek pogleda dlje nazaj

## Česa NE počni
1. **Ne prižigaj nazaj `warmupPackingCache()` po urniku.** Meritev 31. 8.: tekel je
   vsakih 90 s, vsakič 21 strani / 2000 naročil / 145 s — torej praktično neprekinjeno.
   Pisal je ključe `orders_*_last3d`, ki jih **nobena stran ne bere**: `index.html` in
   `topsellers.html` kličeta z `?days=…`, kar gre po poti `isLongWindow` in se postreže
   iz baze (`db:true`). Povrhu je bil ta predpomnilnik odrezan točno pri 2000 naročilih
   (meja 20 strani), zato v njem ni bilo celega 29. 8. — skladišče ni videlo vseh naročil.
2. **Health ne sme meriti svežine predpomnilnika.** Ko je bil warmup ugasnjen, ključ
   `orders_Odpremljen_last3d` ni bil več osvežen in health je bil trajno rdeč, watchdog
   pa je alarmiral v prazno. Meri se `lastChangeSyncTs`, z izjemo ob odprtem circuit
   breakerju (izpad Metakocke ni naša napaka in restart je ne popravi).
3. **Ne piši predpomnilnika za dnevne klice.** Prej so klici z `?date=` in `?changed=`
   pisali 4 JSON kepe na dan v tabelo `cache` — isti podatki kot v `orders`.
   Od tod 134 MB WAL. Po čiščenju: baza 162 MB → 15 MB.

## Full sync (gumb)
`/api/packing/topsellers-sync` gre po dnevih, sprejme `?od=N` za začetni dan.
Po vsakem dnevu zapiše `syncNadaljuj`, zato **preživi restart** in se po zagonu sam
nadaljuje (varovalka: največ 10 nadaljevanj). Rabiš ga le ob prvi vzpostavitvi ali
če bi ChangeSync dalj časa odpovedal — za spremembe statusov ni več potreben.

## Preverjeno 31. 8. 2026
- 8 dni proti Metakocki, vsi statusi: 6 dni popolno ujemanje; 2 odstopanji sta naročili
  nad varovalko `ROLL_MAX_EUR = 800` (ena ima v MK znesek 3.998.733)
- 2269 naročil, starejših od 3 dni, ki so se spremenila danes: **2244 se ujema, 0 razlik**;
  25 jih baza nima, ker so izven 30-dnevnega okna (`KEEP_DAYS = 30`)
- 393 KNEEFIX naročil z dne 2.–12. 8. pravilno v „Odpremljen"
- spakirano: 28.790 vnosov nedotaknjenih (`data/packed-orders.json`, ločeno od baze)
- restart → zdrava v 3 s; odziv strani 0,18–0,29 s
