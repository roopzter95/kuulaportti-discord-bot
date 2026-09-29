// Kuulaportti -> Discord ilmoitusskripti
// Perustuu TenguKnightin alkuperäiseen AirsoftJSON_parse.js -koodiin (Kuulaportin JSON-rajapinnan käyttö).
// Hakee tiimin pelit Kuulaportin virallisesta rajapinnasta (team_events.php)
// ja lähettää uudet julkaistut pelit Discord-webhookiin.

const fs = require('fs');
const path = require('path');

const JSON_URL = 'https://kuulaportti.fi/api/v1/team_events.php';
const SEEN_FILE = path.join(__dirname, 'seen_events.json');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const API_KEY = process.env.KUULAPORTTI_API_KEY;

if (!WEBHOOK_URL) {
  console.error('DISCORD_WEBHOOK_URL puuttuu (GitHub Secrets).');
  process.exit(1);
}
if (!API_KEY) {
  console.error('KUULAPORTTI_API_KEY puuttuu (GitHub Secrets).');
  process.exit(1);
}

function loadSeenIds() {
  try {
    const data = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
    return new Set((data.seen_ids || []).map(String));
  } catch (err) {
    // Tiedostoa ei vielä ole tai se on tyhjä -> aloitetaan tyhjästä.
    return new Set();
  }
}

function saveSeenIds(seenSet) {
  const data = { seen_ids: Array.from(seenSet) };
  fs.writeFileSync(SEEN_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function formatEventTime(startUnix, endUnix) {
  // Haetaan osat Suomen aikavyöhykkeellä (Intl hoitaa kesä-/talviajan automaattisesti).
  const parts = (unix) => {
    const p = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Helsinki',
      day: 'numeric',
      month: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(unix * 1000));
    const get = (type) => p.find((x) => x.type === type).value;
    return {
      pvm: `${Number(get('day'))}.${Number(get('month'))}.${get('year')}`,
      aika: `${get('hour')}:${get('minute')}`,
    };
  };

  const a = parts(startUnix);
  const l = parts(endUnix);
  if (a.pvm === l.pvm) {
    return `${a.pvm} klo ${a.aika} - ${l.aika}`;
  }
  return `${a.pvm} klo ${a.aika} - ${l.pvm} klo ${l.aika}`;
}

// Ilmoitetaan vain julkaistut, tulevat ja peruuttamattomat pelit.
// published_at = 0 tarkoittaa julkaisematonta luonnosta, ja tulevaisuudessa
// oleva published_at ajastettua julkaisua, jota ei vielä ilmoiteta.
function isAnnounceable(event, nowUnix) {
  return (
    event.status === 'upcoming' &&
    !event.cancelled &&
    Number(event.published_at) > 0 &&
    Number(event.published_at) <= nowUnix
  );
}

async function sendDiscordMessage(event) {
  const eventUrl = String(event.url || '').startsWith('https://kuulaportti.fi/')
    ? event.url
    : `https://kuulaportti.fi/?page=event&id=${event.id}`;

  const embed = {
    title: String(event.name || 'Peli').trim(),
    url: eventUrl,
    color: 0x2ecc71,
    fields: [
      { name: 'Pelipaikka', value: event.location?.name || 'Ei tiedossa', inline: true },
      { name: 'Osoite', value: event.location?.address || 'Ei tiedossa', inline: true },
      { name: 'Aika', value: formatEventTime(event.event_start, event.event_end), inline: false },
    ],
  };

  const payload = {
    content: '@everyone 📢 Uusi peli-ilmoitus Kuulaportissa!',
    embeds: [embed],
    allowed_mentions: {
      parse: ['everyone'], // Varmistaa, että @everyone oikeasti tägää eikä näy pelkkänä tekstinä.
    },
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

  const response = await fetch(JSON_URL, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  const json = await response.json().catch(() => null);

  if (!response.ok || !json || json.error) {
    const syy = (json && (json.message || json.error)) || response.statusText;
    throw new Error(`Kuulaportin haku epäonnistui (${response.status}): ${syy}`);
  }

  const nowUnix = Math.floor(Date.now() / 1000);
  const seenIds = loadSeenIds();

  const newEvents = (json.data || [])
    .filter((e) => isAnnounceable(e, nowUnix))
    .filter((e) => !seenIds.has(String(e.id)))
    .sort((a, b) => a.event_start - b.event_start);

  if (newEvents.length === 0) {
    console.log('Ei uusia tapahtumia.');
    return;
  }

  console.log(`Löytyi ${newEvents.length} uutta tapahtumaa. Lähetetään Discordiin...`);

  let virhe = null;

  for (const event of newEvents) {
    try {
      await sendDiscordMessage(event);
      seenIds.add(String(event.id));
      console.log(`Lähetetty: ${event.name} (id: ${event.id})`);
      // Pieni viive, jottei Discordin webhook-rajoitus (rate limit) laukea usealla viestillä.
      await new Promise((r) => setTimeout(r, 1200));
    } catch (err) {
      // Tallennetaan tähän mennessä onnistuneet, jottei niitä lähetetä uudelleen.
      virhe = err;
      break;
    }
  }

  saveSeenIds(seenIds);

  if (virhe) {
    throw virhe;
  }

  console.log('Valmis.');
}

main().catch((err) => {
  console.error('Virhe:', err.message || err);
  process.exit(1);
});
