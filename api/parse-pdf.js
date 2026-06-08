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

    // ─── STEP 1: extrai texto bruto da tabela ────────────────────────────────
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
DATA | ACTIVITY | START | END | DEP | ARR | ACVER | CREWS

Para CREWS, liste todos os tripulantes separados por vírgula no formato NOME:FUNCAO
Exemplo: JOAO SILVA:CA, MARIA SOUZA:FO, ANA LIMA:CL, PEDRO COSTA:FA

Se não houver tripulação, deixe CREWS em branco.
Para Layover, use: DATA | Layover | CHECKIN | CHECKOUT | LOCAL | | |

Transcreva absolutamente TODAS as linhas, sem pular nenhuma.
Não adicione explicações, só a transcrição linha a linha.` }
          ]
        }]
      })
    });

    const step1Data = await step1Response.json();
    if (step1Data.error) throw new Error(step1Data.error.message || 'API error step1');
    const rawText = (step1Data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');

    // ─── STEP 2: converte texto estruturado em JSON ──────────────────────────
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

REGRAS DE CONVERSÃO:

Tipos de atividade (campo "tipo"):
- FR, FP, PP → tipo: "fr" ou "fp", label: "Folga"
- SB+número (ex: SB12) → tipo: "sb", label: "Sobreaviso", detalhe: horário ex "18:00 - 6h"
- RHC, RHC22, RHC23, qualquer RHC+número → tipo: "rea", label: "Reserva" (NUNCA tem voos!)
- AD####, G3###, LA###, JJ### → tipo: "voo", label: "Voo"
- ADP → tipo: "adp", label: "Adaptação"
- Layover → NÃO é um dia separado, adiciona pernoite ao dia anterior

AGRUPAMENTO:
- Múltiplos voos no mesmo dia (mesma data) → 1 objeto só com array "voos" com todos
- A tripulação dos voos é compartilhada entre todos os voos do mesmo dia (mesmo grupo de voo)
- Layover: adiciona {"l":"AEROPORTO","ci":"HH:MM","co":"HH:MM"} ao dia anterior

TRIPULAÇÃO:
- Inclua TODOS os tripulantes listados, sem exceção
- CA = Comandante, FO = Copiloto, CL = Comissário Líder, FA = Comissário, FE = Flight Engineer, SUP = Supervisor
- Se um tripulante tiver só primeiro nome (ex: "JULIA"), use como está

DIAS VAZIOS:
- Se um dia da semana não aparece na transcrição, inclua mesmo assim como folga (tipo: "fr")
- O mês deve ter TODOS os dias, do 1 ao último

FORMATO JSON (retorne APENAS o JSON, sem texto antes ou depois, sem markdown):
{
  "mes": "Junho 2026",
  "resumo": {"voos": 0, "pernoites": 0, "folgas": 0, "sb": 0},
  "dias": [
    {
      "dia": 1,
      "tipo": "fr",
      "label": "Folga",
      "detalhe": "",
      "voos": [],
      "tripulacao": [],
      "pernoite": null
    },
    {
      "dia": 9,
      "tipo": "voo",
      "label": "Voo",
      "detalhe": "",
      "voos": [
        {"n": "AD6704", "o": "VCP", "d": "FLL", "dp": "21:40", "ar": "06:30", "du": "9h50", "ae": "32N"},
        {"n": "AD6705", "o": "FLL", "d": "VCP", "dp": "08:00", "ar": "17:00", "du": "9h00", "ae": "32N"}
      ],
      "tripulacao": [
        {"nome": "JOAO SILVA", "funcao": "CA"},
        {"nome": "MARIA SOUZA", "funcao": "FO"},
        {"nome": "ANA LIMA", "funcao": "CL"},
        {"nome": "PEDRO COSTA", "funcao": "FA"},
        {"nome": "JULIA SANTOS", "funcao": "FA"}
      ],
      "pernoite": {"l": "FLL", "ci": "07:00", "co": "20:00"}
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
      // Retorna o texto bruto pra debug
      return res.status(500).json({
        error: 'Falha ao converter JSON',
        rawExtraction: rawText.substring(0, 1000),
        rawJson: jsonText.substring(0, 1000)
      });
    }

    // ─── NORMALIZA ───────────────────────────────────────────────────────────
    const labels = { fr: 'Folga', fp: 'Folga', voo: 'Voo', rea: 'Reserva', sb: 'Sobreaviso', adp: 'Adaptação' };
    (parsed.dias || []).forEach(d => {
      if (!d.voos) d.voos = [];
      if (!d.tripulacao) d.tripulacao = [];
      if (!d.pernoite) d.pernoite = null;
      if (!d.detalhe) d.detalhe = '';
      if (!d.label) d.label = labels[d.tipo] || d.tipo;
    });

    // ─── RECALCULA RESUMO ─────────────────────────────────────────────────────
    const resumo = { voos: 0, pernoites: 0, folgas: 0, sb: 0 };
    (parsed.dias || []).forEach(d => {
      if (d.tipo === 'voo') {
        resumo.voos += d.voos.length > 0 ? d.voos.length : 1;
        if (d.pernoite) resumo.pernoites++;
      } else if (d.tipo === 'fr' || d.tipo === 'fp') {
        resumo.folgas++;
      } else if (d.tipo === 'sb') {
        resumo.sb++;
      }
    });
    parsed.resumo = resumo;

    return res.status(200).json({
      content: [{
        type: 'text',
        text: JSON.stringify(parsed)
      }]
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
