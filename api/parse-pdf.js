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

ATENÇÃO — leia com extremo cuidado:
- "Activity": copie o código EXATAMENTE como está (ex: AD8750, AD4508, FR, FP, FC, FA, SB18, RHC22)
- "Dep": aeroporto de ORIGEM 3 letras (ex: VCP, LIS, OPO). NUNCA deixe vazio — se está na tabela, copie.
- "Arr": aeroporto de DESTINO 3 letras (ex: LIS, VCP, REC). NUNCA deixe vazio.
- "AcVer": modelo da aeronave EXATAMENTE como está (ex: 763, 772, 32N, 32Q, 32A, ATR, 330). Não altere.
- "DD/CAT": copie exatamente (ex: V, COBS, DHD, ou vazio)
- "Crews": liste TODOS os tripulantes sem exceção no formato NOME:FUNCAO

Formato de saída — uma linha por atividade:
DATA | ACTIVITY | START | END | DEP | ARR | ACVER | DDCAT | CREWS

Onde:
- DATA = data da coluna Start em DD/MM/AAAA
- CREWS = NOME1:FUNC1, NOME2:FUNC2, ... (todos os tripulantes)
- Para Layover: DATA | Layover | START | END | LOCAL | LOCAL | | |

Transcreva TODAS as linhas sem pular nenhuma. Sem explicações.` }
          ]
        }]
      })
    });

    const step1Data = await step1Response.json();
    if (step1Data.error) throw new Error(step1Data.error.message || 'API error step1');
    const rawText = (step1Data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');

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
            text: `Converta esta transcrição de escala de voo em JSON seguindo EXATAMENTE o formato especificado.

TRANSCRIÇÃO:
${rawText}

═══ TIPOS DE ATIVIDADE ═══
FR, FP, PP → tipo: "fr" ou "fp", label: "Folga" ou "Folga Programada"
FC  → tipo: "fc", label: "Folga Casada"
FA  → tipo: "fa", label: "Folga Aniversário"  ← só quando FA é a atividade, não função
SB+número → tipo: "sb", label: "Sobreaviso", detalhe: ex "20:00 - 12h"
RHC+qualquer → tipo: "rea", label: "Reserva" — NUNCA tem voos
ADP  → tipo: "adp", label: "Adaptação"
ADPOB → tipo: "adpob", label: "Adaptação fora da base"
AD####, G3###, LA###, JJ### → tipo: "voo", label: "Voo"
DHD → tipo: "voo", label: "DHD · Extra a Serviço", dhd: true
Layover → NÃO é dia separado, vira pernoite no dia anterior
DDCAT "COBS" ou "V" → euroAtlantic: true no dia

═══ AGRUPAMENTO ═══
Múltiplos voos na mesma data → 1 objeto de dia, array "voos" com todos
Layover → pernoite: {"l":"AEROPORTO","ci":"HH:MM","co":"HH:MM"} no dia anterior
Dias ausentes → incluir como tipo "fr"
O mês deve ter TODOS os dias do 1 ao último

═══ FUNÇÕES DE TRIPULAÇÃO ═══
CA→"CA", FO→"FO", CL→"CL", FA→"FA", FE→"FE", SUP→"SUP", COBS→"SUP", V→"SUP", DHD→"DHD"
Incluir TODOS os tripulantes listados.

═══ FORMATO OBRIGATÓRIO DOS VOOS ═══
ATENÇÃO: use EXATAMENTE estes nomes de campos para cada voo:
- "n"  = número do voo (ex: "AD8750")
- "o"  = origem 3 letras (ex: "VCP") — NUNCA null
- "d"  = destino 3 letras (ex: "LIS") — NUNCA null
- "dp" = horário partida "HH:MM"
- "ar" = horário chegada "HH:MM"
- "du" = duração calculada (ex: "11h30")
- "ae" = aeronave (ex: "763", "32N", "330")

NÃO use: "voo", "partida", "chegada", "origem", "destino", "aeronave" — esses nomes estão ERRADOS.
Use APENAS: "n", "o", "d", "dp", "ar", "du", "ae"

Retorne APENAS o JSON válido, sem texto antes ou depois, sem markdown, sem backticks:

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
      "dia": 26,
      "tipo": "voo",
      "label": "Voo",
      "detalhe": "",
      "dhd": false,
      "euroAtlantic": false,
      "voos": [
        {"n": "AD8750", "o": "VCP", "d": "LIS", "dp": "04:45", "ar": "17:55", "du": "13h10", "ae": "763"}
      ],
      "tripulacao": [
        {"nome": "SCANDUZZI", "funcao": "CA"},
        {"nome": "SONI", "funcao": "FO"},
        {"nome": "JULIETTI GALHARDO", "funcao": "CL"},
        {"nome": "NATALI MICHELLIM", "funcao": "FE"},
        {"nome": "ERICKSON RODRIGUES", "funcao": "FA"}
      ],
      "pernoite": {"l": "LIS", "ci": "17:55", "co": "04:45"}
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
      try { return JSON.parse(match[0]); }
      catch (e) {
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

    // ─── NORMALIZA E CORRIGE CAMPOS ───────────────────────────────────────────
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

      // Corrige campos com nomes errados nos voos
      d.voos = d.voos.map(v => {
        const corrected = {};
        corrected.n   = v.n   || v.voo    || v.numero   || v.flight || '';
        corrected.o   = v.o   || v.origem  || v.dep      || v.from   || '';
        corrected.d   = v.d   || v.destino || v.arr      || v.to     || '';
        corrected.dp  = v.dp  || (v.partida  ? v.partida.substring(11,16)  : '') || '';
        corrected.ar  = v.ar  || (v.chegada  ? v.chegada.substring(11,16)  : '') || '';
        corrected.du  = v.du  || v.duracao  || v.duration || '';
        corrected.ae  = v.ae  || v.aeronave || v.aircraft || v.acver  || '';
        return corrected;
      });
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
