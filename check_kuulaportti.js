// Kuulaportti -> Discord ilmoitusskripti
// Perustuu TenguKnightin alkuperäiseen AirsoftJSON_parse.js -koodiin (Kuulaportin JSON-rajapinnan käyttö).
// Hakee tiimin tulevat pelit Kuulaportista ja lähettää uudet tapahtumat Discord-webhookiin.

const fs = require('fs');
const path = require('path');

const TEAM_ID = 213;
const JSON_URL = `https://kuulaportti.fi/ajax.php?request=events&type=team&id=${TEAM_ID}&subtype=upcoming`;
const SEEN_FILE = path.join(__dirname, 'seen_events.json');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

if (!WEBHOOK_URL) {
  console.error('DISCORD_WEBHOOK_URL puuttuu ympäristömuuttujista (GitHub Secrets).');
  process.exit(1);
}

function loadSeenIds() {
  try {
    const raw = fs.readFileSync(SEEN_FILE, 'utf8');
    const data = JSON.parse(raw);
    return new Set(data.seen_ids || []);
  } catch (err) {
    // Tiedostoa ei vielä ole tai se on tyhjä -> aloitetaan tyhjästä setistä.
    return new Set();
  }
}

function saveSeenIds(seenSet) {
  const data = { seen_ids: Array.from(seenSet) };
  fs.writeFileSync(SEEN_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function formatEventTime(startUnix, endUnix) {
  const alku = new Date(startUnix * 1000);
  const loppu = new Date(endUnix * 1000);

  const pad = (n) => String(n).padStart(2, '0');

  // Käytetään UTC-arvoja + kiinteää Suomen ajan offsettia (UTC+2 talvi / UTC+3 kesä).
  // Yksinkertaisuuden vuoksi käytetään Intl-apuria oikean Helsinki-ajan saamiseksi.
  const dateFmt = new Intl.DateTimeFormat('fi-FI', {
    timeZone: 'Europe/Helsinki',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  const timeFmt = new Intl.DateTimeFormat('fi-FI', {
    timeZone: 'Europe/Helsinki',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const alkuPvm = dateFmt.format(alku);
  const alkuAika = timeFmt.format(alku);
  const loppuAika = timeFmt.format(loppu);

  return `${alkuPvm} klo ${alkuAika} - ${loppuAika}`;
}

async function sendDiscordMessage(event) {
  const eventUrl = `https://kuulaportti.fi/?page=event&id=${event.id}`;
  const aikaTeksti = formatEventTime(event.event_start, event.event_end);

  const embed = {
    title: event.name,
    url: eventUrl,
    color: 0x2ecc71,
    fields: [
      { name: 'Pelipaikka', value: event.location_name || 'Ei tiedossa', inline: true },
      { name: 'Osoite', value: event.address || 'Ei tiedossa', inline: true },
      { name: 'Aika', value: aikaTeksti, inline: false },
    ],
  };

  const payload = {
    content: '📢 Uusi peli-ilmoitus Kuulaportissa!',
    embeds: [embed],
  };

  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord-webhook epäonnistui (${res.status}): ${text}`);
  }
}

async function main() {
  console.log(`Haetaan tapahtumat: ${JSON_URL}`);

  const response = await fetch(JSON_URL);
  if (!response.ok) {
    throw new Error(`Kuulaportin haku epäonnistui: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  const events = json.data || [];

  const seenIds = loadSeenIds();
  const newEvents = events.filter((e) => !seenIds.has(String(e.id)));

  if (newEvents.length === 0) {
    console.log('Ei uusia tapahtumia.');
    return;
  }

  console.log(`Löytyi ${newEvents.length} uutta tapahtumaa. Lähetetään Discordiin...`);

  for (const event of newEvents) {
    await sendDiscordMessage(event);
    seenIds.add(String(event.id));
    console.log(`Lähetetty: ${event.name} (id: ${event.id})`);
  }

  saveSeenIds(seenIds);
  console.log('Valmis.');
}

main().catch((err) => {
  console.error('Virhe:', err);
  process.exit(1);
});
