module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    const { fileData, mediaType } = req.body;
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

Transcreva TODAS as linhas da tabela, uma por linha, no formato:
DATA | ACTIVITY | START | END | DEP | ARR | ACVER | DDCAT | CREWS

- DATA: use a data da coluna Start no formato DD/MM/AAAA
- DDCAT: copie exatamente o valor da coluna DD/CAT (ex: V, COBS, DHD, vazio)
- Para CREWS: liste TODOS os tripulantes separados por vírgula no formato NOME:FUNCAO
  Exemplo: JOAO SILVA:CA, MARIA SOUZA:FO, ANA LIMA:CL, PEDRO COSTA:FA, ELIZAMA IODES:V
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
DHD  → tipo: "voo",   label: "DHD · Extra a Serviço", dhd: true  — voo de outra cia a serviço
Código AD####, G3###, LA###, JJ### → tipo: "voo", label: "Voo"
Se DDCAT for "COBS" ou "V" → é voo Euro Atlantic: adicionar euroAtlantic: true no objeto do dia

═══ AGRUPAMENTO ═══
- Múltiplos voos na mesma data → 1 objeto de dia com array "voos" contendo todos
- Tripulação é compartilhada entre voos do mesmo dia
- Layover: adiciona pernoite {"l":"AEROPORTO","ci":"HH:MM","co":"HH:MM"} ao dia anterior

═══ TRIPULAÇÃO — MAPEAMENTO DE FUNÇÕES ═══
CA   → "CA"   (Comandante)
FO   → "FO"   (Copiloto)
CL   → "CL"   (Comissário Líder)
FA   → "FA"   (Comissário)
FE   → "FE"   (Flight Engineer)
SUP  → "SUP"  (Supervisor)
COBS → "SUP"  (Supervisor Euro Atlantic)
V    → "SUP"  (Supervisor Euro Atlantic)
DHD  → "DHD"  (Extra a serviço)
Inclua TODOS os tripulantes listados, sem exceção.

═══ DIAS VAZIOS ═══
Se um dia não aparece na transcrição, inclua como tipo "fr", label "Folga".
O mês deve ter TODOS os dias do 1 ao último.

═══ FORMATO JSON ═══
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
    },
    {
      "dia": 3,
      "tipo": "voo",
      "label": "Voo",
      "detalhe": "",
      "dhd": false,
      "euroAtlantic": false,
      "voos": [
        {"n": "AD8750", "o": "VCP", "d": "LIS", "dp": "16:40", "ar": "04:10", "du": "11h30", "ae": "763"}
      ],
      "tripulacao": [
        {"nome": "DANIELE", "funcao": "SUP"},
        {"nome": "ELIZAMA IODES", "funcao": "SUP"}
      ],
      "pernoite": null
    },
    {
      "dia": 21,
      "tipo": "voo",
      "label": "Voo",
      "detalhe": "",
      "dhd": false,
      "euroAtlantic": true,
      "voos": [
        {"n": "AD8800", "o": "VCP", "d": "OPO", "dp": "19:40", "ar": "05:20", "du": "9h40", "ae": "763"}
      ],
      "tripulacao": [
        {"nome": "THALYSSA ROCHA", "funcao": "SUP"},
        {"nome": "ELIZAMA IODES", "funcao": "SUP"}
      ],
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
        rawExtraction: rawText.substring(0, 1000),
        rawJson: jsonText.substring(0, 1000)
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
