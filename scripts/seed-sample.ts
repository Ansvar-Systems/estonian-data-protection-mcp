/**
 * Seed the AKI database with sample decisions and guidelines for testing.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["AKI_DB_PATH"] ?? "data/aki.db";
const force = process.argv.includes("--force");

const dir = dirname(DB_PATH);
if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); }
if (force && existsSync(DB_PATH)) { unlinkSync(DB_PATH); console.log(`Deleted existing database at ${DB_PATH}`); }

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);
console.log(`Database initialised at ${DB_PATH}`);

interface TopicRow { id: string; name_local: string; name_en: string; description: string; }

const topics: TopicRow[] = [
  { id: "cookies", name_local: "Küpsised ja jälgijad", name_en: "Cookies and trackers", description: "Küpsiste ja muude jälgijate kasutamine kasutajate seadmetes (IKÜM art 6)." },
  { id: "employee_monitoring", name_local: "Töötajate jälgimine", name_en: "Employee monitoring", description: "Töötajate andmete töötlemine ja jälgimine töökohal." },
  { id: "video_surveillance", name_local: "Videojälgimine", name_en: "Video surveillance", description: "Videojälgimissüsteemide kasutamine ja isikuandmete kaitse (IKÜM art 6)." },
  { id: "data_breach", name_local: "Andmelekke teavitamine", name_en: "Data breach notification", description: "Isikuandmete lekke teavitamine AKI-le ja andmesubjektidele (IKÜM art 33–34)." },
  { id: "consent", name_local: "Nõusolek", name_en: "Consent", description: "Isikuandmete töötlemiseks nõusoleku saamine, kehtivus ja tagasivõtmine (IKÜM art 7)." },
  { id: "dpia", name_local: "Andmekaitsealane mõjuhinnang", name_en: "Data Protection Impact Assessment (DPIA)", description: "Andmekaitsealane mõjuhinnang kõrge riskiga töötlemise jaoks (IKÜM art 35)." },
  { id: "transfers", name_local: "Rahvusvahelised andmeedastused", name_en: "International data transfers", description: "Isikuandmete edastamine kolmandatesse riikidesse või rahvusvahelistele organisatsioonidele (IKÜM art 44–49)." },
  { id: "data_subject_rights", name_local: "Andmesubjektide õigused", name_en: "Data subject rights", description: "Juurdepääsu-, parandamis-, kustutamis- ja muude õiguste teostamine (IKÜM art 15–22)." },
];

const insertTopic = db.prepare("INSERT OR IGNORE INTO topics (id, name_local, name_en, description) VALUES (?, ?, ?, ?)");
for (const t of topics) { insertTopic.run(t.id, t.name_local, t.name_en, t.description); }
console.log(`Inserted ${topics.length} topics`);

interface DecisionRow {
  reference: string; title: string; date: string; type: string;
  entity_name: string; fine_amount: number | null; summary: string;
  full_text: string; topics: string; gdpr_articles: string; status: string;
}

const decisions: DecisionRow[] = [
  {
    reference: "AKI-2022-003",
    title: "AKI otsus küpsiste kasutamise rikkumise kohta",
    date: "2022-04-18",
    type: "sanction",
    entity_name: "Veebikaubanduse ettevõte",
    fine_amount: 8000,
    summary: "AKI määras 8 000 EUR trahvi veebikaubanduse ettevõttele analüütiliste ja reklaamiküpsiste kasutamise eest ilma kasutajate eelneva nõusolekuta.",
    full_text: "Andmekaitse Inspektsioon viis läbi kontrolli pärast kasutajate kaebusi. Tuvastati, et ettevõte aktiveeris reklaam- ja analüütikaküpsised kohe veebisaidile sisenemisel, enne kui kasutaja sai oma valiku teha. Nõusoleku bänner kuvati pärast küpsiste aktiveerimist. Leiti järgmised rikkumised: 1) küpsised aktiveeriti enne nõusoleku saamist; 2) keeldumismehhanism oli oluliselt keerulisem kui nõusolekuandmise protsess; 3) teave küpsiste eesmärkide kohta oli ebapiisav. Ettevõttele määrati 8 000 EUR trahv ja kohustati rikkumised 60 päeva jooksul kõrvaldama.",
    topics: JSON.stringify(["cookies", "consent"]),
    gdpr_articles: JSON.stringify(["6", "7"]),
    status: "final",
  },
  {
    reference: "AKI-2022-011",
    title: "AKI otsus töötajate GPS-jälgimise kohta",
    date: "2022-08-25",
    type: "sanction",
    entity_name: "Logistikaettevõte",
    fine_amount: 16000,
    summary: "AKI määras 16 000 EUR trahvi logistikaettevõttele töötajate pideva GPS-jälgimise eest nii tööajal kui ka väljaspool tööaega, rikkudes proportsionaalsuse põhimõtet.",
    full_text: "AKI sai töötajate kaebusi pideva GPS-jälgimise kohta sõidukihaldussüsteemi kaudu. Uurimine tõi esile: 1) GPS-andmeid koguti ööpäevaringselt 7 päeva nädalas, sealhulgas väljaspool tööaega ja nädalavahetustel; 2) töötajaid ei olnud enne süsteemi kasutuselevõttu töötlemise ulatusest ja eesmärkidest nõuetekohaselt teavitatud; 3) andmeid säilitati 2 aastat põhjendamatu tähtaja jooksul. AKI rõhutas, et GPS-jälgimine on lubatud ainult tööajal ja konkreetsetel õiguspärastel eesmärkidel. Ettevõttele määrati 16 000 EUR trahv.",
    topics: JSON.stringify(["employee_monitoring"]),
    gdpr_articles: JSON.stringify(["5", "6", "13"]),
    status: "final",
  },
  {
    reference: "AKI-2023-006",
    title: "AKI otsus andmelekke hilinenud teavitamise kohta",
    date: "2023-03-14",
    type: "sanction",
    entity_name: "Tervishoiuasutus",
    fine_amount: 28000,
    summary: "AKI määras 28 000 EUR trahvi tervishoiuasutusele andmelekke teavitamise hilinemise eest — teatis esitati 10 päeva pärast intsidendi avastamist, mitte 72 tunni jooksul.",
    full_text: "Tervishoiuasutus langes küberrünnaku ohvriks, mille käigus ohustati umbes 12 000 patsiendi isikuandmeid, sealhulgas meditsiinilist teavet. AKI tuvastas järgmised rikkumised: 1) AKI-le esitati teatis 10 päeva pärast intsidendi avastamist, rikudes 72-tunnist tähtaega; 2) teatis oli puudulik — ei sisaldanud ohustatud andmete liiki, mõjutatud isikute arvu ega riskihinnangut; 3) mõjutatud patsiente ei teavitatud, kuigi juhtum kujutas neile suurt ohtu. Ettevõttele määrati 28 000 EUR trahv.",
    topics: JSON.stringify(["data_breach"]),
    gdpr_articles: JSON.stringify(["33", "34"]),
    status: "final",
  },
  {
    reference: "AKI-2023-018",
    title: "AKI otsus videojälgimise kohta töökohal",
    date: "2023-07-20",
    type: "warning",
    entity_name: "Jaekaubandusvõrk",
    fine_amount: null,
    summary: "AKI andis hoiatuse jaekaubandusvõrgule videovalvekaamera paigaldamise eest töötajate puhketubadesse ja ebapiisava teavitamise eest videojälgimise kohta.",
    full_text: "AKI viis läbi plaanilisi kontrolle jaekaubanduspoodides ja avastas, et videovalvekaamerad olid paigaldatud töötajate puhketubadesse — riietusruumidesse ja puhkeruumidesse. See on ilmne proportsionaalsuse põhimõtte rikkumine, kuna töötajate privaatsetes tsoonides nii intensiivseks jälgimiseks puudub õiguslik alus. Lisaks ei olnud töötajaid kaamera asukohtadest ja töödeldavate andmete ulatusest nõuetekohaselt teavitatud. AKI andis hoiatuse ja kohustas: 1) viivitamatult eemaldama kaamerad töötajate puhketubadest; 2) vaatama läbi videojälgimispoliitika; 3) koostama ja avaldama töötajatele selge teabe.",
    topics: JSON.stringify(["video_surveillance", "employee_monitoring"]),
    gdpr_articles: JSON.stringify(["5", "6", "13"]),
    status: "final",
  },
  {
    reference: "AKI-2023-032",
    title: "AKI otsus otseposti saatmise kohta ilma nõusolekuta",
    date: "2023-10-05",
    type: "sanction",
    entity_name: "Kindlustusselts",
    fine_amount: 12000,
    summary: "AKI määras 12 000 EUR trahvi kindlustusseltsile turunduskirjade saatmise eest klientidele ilma kehtiva nõusolekuta ja lihtsa loobumisviisi puudumise eest.",
    full_text: "AKI uuris kaebusi tarbijatelt, kes said kindlustusseltsilt soovimatuid turunduskirju. Uurimine tõi esile: 1) selts saatis turundussõnumeid isikutele, kes ei olnud selgesõnaliselt nõustunud neid sõnumeid saama — nõusolek oli saadud eelnevalt märgistatud märkeruutude kaudu; 2) loobumise link oli e-kirja allosas väikese kirjaga peidetud; 3) mõned tarbijad teatasid, et said kirju mitu nädalat pärast loobumist. AKI rõhutas, et turunduskirjadeks nõusolek tuleb saada aktiivse tegevuse kaudu. Seltsile määrati 12 000 EUR trahv.",
    topics: JSON.stringify(["consent"]),
    gdpr_articles: JSON.stringify(["6", "7"]),
    status: "final",
  },
];

const insertDecision = db.prepare(`INSERT OR IGNORE INTO decisions (reference, title, date, type, entity_name, fine_amount, summary, full_text, topics, gdpr_articles, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const insertDecisionsAll = db.transaction(() => { for (const d of decisions) { insertDecision.run(d.reference, d.title, d.date, d.type, d.entity_name, d.fine_amount, d.summary, d.full_text, d.topics, d.gdpr_articles, d.status); } });
insertDecisionsAll();
console.log(`Inserted ${decisions.length} decisions`);

interface GuidelineRow { reference: string | null; title: string; date: string; type: string; summary: string; full_text: string; topics: string; language: string; }

const guidelines: GuidelineRow[] = [
  {
    reference: "AKI-JUHEND-KUPSISED-2022",
    title: "Juhend küpsiste kasutamiseks",
    date: "2022-02-10",
    type: "guide",
    summary: "AKI juhend küpsiste ja muude jälgijate kasutamise kohta. Hõlmab nõusoleku nõudeid, kasutajate teavitamist ja keeldumismehhanisme.",
    full_text: "See juhend selgitab Eestis kehtivaid küpsiste kasutamise nõudeid vastavalt IKÜMile ja elektroonilise side seadusele. Peamised nõuded: 1) Nõusolek enne küpsiseid — mittevajalikele küpsistele (reklaam, analüütika) on vajalik eelnev, selge ja aktiivne kasutaja nõusolek; ainult veebisaidi toimimiseks vajalikke küpsiseid võib kasutada ilma nõusolekuta; 2) Võrdne juurdepääs — kasutajatele peab olema tagatud sama lihtne võimalus nii küpsistega nõustumiseks kui keeldumiseks; 3) Teave — selge teave küpsiste eesmärkide, kestuse ja kolmandate osapoolte kohta; 4) Tagasivõtmine — kasutajad peavad saama oma nõusoleku igal ajal tagasi võtta.",
    topics: JSON.stringify(["cookies", "consent"]),
    language: "et",
  },
  {
    reference: "AKI-JUHEND-DPIA-2021",
    title: "Andmekaitsealase mõjuhinnangu läbiviimise juhend",
    date: "2021-10-05",
    type: "guide",
    summary: "AKI metoodilised juhised andmekaitsealase mõjuhinnangu (DPIA) läbiviimiseks. Hõlmab, millal DPIA on kohustuslik, kuidas seda läbi viia ja dokumenteerida.",
    full_text: "IKÜM artikkel 35 nõuab andmekaitsealase mõjuhinnangu läbiviimist, kui töötlemine võib põhjustada suurt ohtu füüsiliste isikute õigustele ja vabadustele. DPIA on kohustuslik: suures mahus biomeetriliste või tervisandmete töötlemisel; avalike alade süstemaatilisel jälgimisel; andmete töötlemisel automatiseeritud otsuste tegemiseks, millel on õiguslikud tagajärjed. DPIA etapid: 1) Töötlemise kirjeldus — andmete kategooriad, eesmärgid, saajad, edastamine, säilitamistähtaeg; 2) Vajalikkuse ja proportsionaalsuse hindamine; 3) Riskide haldamine — ohtude tuvastamine, tõenäosuse ja raskuse hindamine, täiendavate meetmete määratlemine.",
    topics: JSON.stringify(["dpia"]),
    language: "et",
  },
  {
    reference: "AKI-JUHEND-ANDMESUBJEKTID-2022",
    title: "Andmesubjektide õiguste teostamise juhend",
    date: "2022-06-20",
    type: "guide",
    summary: "AKI juhend andmesubjektide õiguste — juurdepääsu, parandamise, kustutamise, piiramise, ülekandmise ja vastuväite — teostamise kohta.",
    full_text: "IKÜM annab andmesubjektidele ulatuslikud õigused seoses nende isikuandmete töötlemisega. Peamised õigused: 1) Õigus andmetele juurdepääsuks (art 15) — isikul on õigus saada kinnitust andmete töötlemise kohta ja nende koopia; vastus tuleb anda 1 kuu jooksul; 2) Õigus andmete parandamisele (art 16) — ebatäpsed andmed tuleb parandada ilma põhjendamatu viivituseta; 3) Õigus andmete kustutamisele (art 17) — 'õigus olla unustatud' teatud tingimustel; 4) Õigus töötlemise piiramisele (art 18); 5) Õigus andmete ülekandmisele (art 20); 6) Õigus esitada vastuväiteid (art 21). Organisatsioonidel peavad olema selged protseduurid nende õiguste tagamiseks.",
    topics: JSON.stringify(["data_subject_rights"]),
    language: "et",
  },
];

const insertGuideline = db.prepare(`INSERT INTO guidelines (reference, title, date, type, summary, full_text, topics, language) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const insertGuidelinesAll = db.transaction(() => { for (const g of guidelines) { insertGuideline.run(g.reference, g.title, g.date, g.type, g.summary, g.full_text, g.topics, g.language); } });
insertGuidelinesAll();
console.log(`Inserted ${guidelines.length} guidelines`);

const dc = (db.prepare("SELECT count(*) as cnt FROM decisions").get() as { cnt: number }).cnt;
const gc = (db.prepare("SELECT count(*) as cnt FROM guidelines").get() as { cnt: number }).cnt;
const tc = (db.prepare("SELECT count(*) as cnt FROM topics").get() as { cnt: number }).cnt;
console.log(`\nDatabase summary:\n  Topics: ${tc}\n  Decisions: ${dc}\n  Guidelines: ${gc}\n\nDone. Database ready at ${DB_PATH}`);
db.close();
