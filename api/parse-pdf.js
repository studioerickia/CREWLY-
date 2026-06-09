module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    const { fileData, mediaType, debug } = req.body;
    if (!fileData) return res.status(400).json({ error: 'No file data' });

    const isImage = (mediaType || '').startsWith('image/');
    const mt = mediaType || 'application/pdf';
    const contentType = isImage ? 'image' : 'document';

    // ─── STEP 1: transcrição fiel do PDF ────────────────────────────────────
    const step1Response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
        messages: [{
          role: 'user',
          content: [
            { type: contentType, source: { type: 'base64', media_type: mt, data: fileData } },
            { type: 'text', text: `Você está lendo uma escala do app "Minha Escala" da Azul Linhas Aéreas.

A tabela tem colunas: Activity | Checkin | Start | End | Checkout | Dep | Arr | AcVer | DD/CAT | Crews

A coluna Crews tem uma sub-tabela com "Crew" (nome) e "Function" (função).

ATENÇÃO — leia com cuidado:
- A coluna "Activity" contém o código exato do voo. Copie EXATAMENTE como está, letra por letra.
  Exemplos corretos: AD8750, AD8901, AD4508, AD8800, AD8003
  NUNCA invente letras. Se está escrito "AD8750", copie "AD8750", não "ADB750".
- A coluna "Arr" é o aeroporto de DESTINO (3 letras: LIS, VCP, OPO, REC, etc). Nunca deixe vazio.
- A coluna "AcVer" é o modelo da aeronave (ex: 763, 772, 32N, 32Q, ATR). Copie exatamente.
- A coluna "DD/CAT" pode conter: V, COBS, DHD, ou estar vazia. Copie exatamente.

Transcreva TODAS as linhas da tabela, uma por linha, no formato:
DATA | ACTIVITY | START | END | DEP | ARR | ACVER | DDCAT | CREWS

- DATA: use a data da coluna Start no formato DD/MM/AAAA
- Para CREWS: liste TODOS os tripulantes separados por vírgula no formato NOME:FUNCAO
  Exemplo: DANIELE:COBS, ELIZAMA IODES:V
- Se não houver tripulação, deixe CREWS em branco
- Para Layover: DATA | Layover | START | END | DEP | ARR | | |
- Transcreva absolutamente TODAS as linhas sem pular nenhuma
- Não adicione explicações, só a transcrição` }
          ]
        }]
      })
    });

    const step1Data = await step1Response.json();
    if (step1Data.error) throw new Error(step1Data.error.message || 'API error step1');
    const rawText = (step1Data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');

    // Modo debug: retorna só a transcrição do step 1
    if (debug) {
      return res.status(200).json({ debug: true, rawText });
    }

    // ─── STEP 2: converte para JSON ──────────────────────────────────────────
    const step2Response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
        messages: [{
          role: 'user',
          content: [{
            type: 'text',
            text: `Converta esta transcrição de escala de voo em JSON.

TRANSCRIÇÃO:
${rawText}

═══ REGRAS DE TIPO (campo "tipo") ═══

FR  → tipo: "fr",    label: "Folga"
FP  → tipo: "fp",    label: "Folga Programada"
PP  → tipo: "fp",    label: "Folga"
FC  → tipo: "fc",    label: "Folga Casada"
FA  → tipo: "fa",    label: "Folga Aniversário"   ← atividade FA, não função de tripulante
SB+número → tipo: "sb",   label: "Sobreaviso",  detalhe: horário ex "18:00 - 6h"
RHC (qualquer variação) → tipo: "rea",  label: "Reserva"  — NUNCA tem voos
ADP  → tipo: "adp",   label: "Adaptação"
ADPOB → tipo: "adpob", label: "Adaptação fora da base"
Layover → NÃO é dia separado, vira pernoite do dia anterior
DHD  → tipo: "voo",   label: "DHD · Extra a Serviço", dhd: true
Código AD####, G3###, LA###, JJ### → tipo: "voo", label: "Voo"
Se DDCAT for "COBS" ou "V" → adicionar euroAtlantic: true no objeto do dia

═══ AGRUPAMENTO ═══
- Múltiplos voos na mesma data → 1 objeto de dia com array "voos" contendo todos
- Tripulação é compartilhada entre voos do mesmo dia
- Layover: adiciona pernoite {"l":"AEROPORTO","ci":"HH:MM","co":"HH:MM"} ao dia anterior

═══ TRIPULAÇÃO ═══
CA → "CA", FO → "FO", CL → "CL", FA → "FA", FE → "FE", SUP → "SUP"
COBS → "SUP", V → "SUP", DHD → "DHD"
Inclua TODOS os tripulantes, sem exceção.

═══ DIAS VAZIOS ═══
Se um dia não aparece, inclua como tipo "fr". O mês deve ter TODOS os dias do 1 ao último.

Retorne APENAS o JSON válido, sem texto antes ou depois, sem markdown, sem backticks.

{
  "mes": "Junho 2026",
  "resumo": {"voos": 0, "pernoites": 0, "folgas": 0, "sb": 0},
  "dias": [
    {
      "dia": 1,
      "tipo": "fr",
      "label": "Folga",
      "detalhe": "",
      "dhd": false,
      "euroAtlantic": false,
      "voos": [],
      "tripulacao": [],
      "pernoite": null
    }
  ]
}`
          }]
        }]
      })
    });

    const step2Data = await step2Response.json();
    if (step2Data.error) throw new Error(step2Data.error.message || 'API error step2');
    const jsonText = (step2Data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');

    // ─── PARSE E REPAIR ──────────────────────────────────────────────────────
    const extractAndRepair = (text) => {
      let clean = text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
      const match = clean.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try {
        return JSON.parse(match[0]);
      } catch (e) {
        let t = match[0];
        t = t.replace(/,\s*([}\]])/g, '$1');
        let opens = 0, objOpens = 0;
        for (let c of t) {
          if (c === '[') opens++;
          else if (c === ']') opens--;
          if (c === '{') objOpens++;
          else if (c === '}') objOpens--;
        }
        while (opens > 0) { t += ']'; opens--; }
        while (objOpens > 0) { t += '}'; objOpens--; }
        try { return JSON.parse(t); } catch (e2) { return null; }
      }
    };

    const parsed = extractAndRepair(jsonText);

    if (!parsed) {
      return res.status(500).json({
        error: 'Falha ao converter JSON',
        rawExtraction: rawText.substring(0, 2000),
        rawJson: jsonText.substring(0, 2000)
      });
    }

    // ─── NORMALIZA ───────────────────────────────────────────────────────────
    const labels = {
      fr: 'Folga', fp: 'Folga Programada', fc: 'Folga Casada',
      fa: 'Folga Aniversário', voo: 'Voo', rea: 'Reserva',
      sb: 'Sobreaviso', adp: 'Adaptação', adpob: 'Adaptação fora da base'
    };

    (parsed.dias || []).forEach(d => {
      if (!d.voos) d.voos = [];
      if (!d.tripulacao) d.tripulacao = [];
      if (!d.pernoite) d.pernoite = null;
      if (!d.detalhe) d.detalhe = '';
      if (d.dhd === undefined) d.dhd = false;
      if (d.euroAtlantic === undefined) d.euroAtlantic = false;
      if (!d.label) d.label = labels[d.tipo] || d.tipo;
    });

    // ─── RECALCULA RESUMO ─────────────────────────────────────────────────────
    const resumo = { voos: 0, pernoites: 0, folgas: 0, sb: 0 };
    (parsed.dias || []).forEach(d => {
      if (d.tipo === 'voo') {
        resumo.voos += d.voos.length > 0 ? d.voos.length : 1;
        if (d.pernoite) resumo.pernoites++;
      } else if (['fr', 'fp', 'fc', 'fa'].includes(d.tipo)) {
        resumo.folgas++;
      } else if (d.tipo === 'sb') {
        resumo.sb++;
      }
    });
    parsed.resumo = resumo;

    return res.status(200).json({
      content: [{ type: 'text', text: JSON.stringify(parsed) }]
    });

  } catch (err) {
    console.error('Parser error:', err);
    return res.status(500).json({ error: err.message });
  }
};

module.exports.config = {
  api: {
    bodyParser: { sizeLimit: '10mb' },
    maxDuration: 60
  }
};
