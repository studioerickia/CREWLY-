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

    const makeRequest = async (prompt) => {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
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
              { type: 'text', text: prompt }
            ]
          }]
        })
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message || 'API error');
      return (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    };

    // ─── PROMPT BASE ────────────────────────────────────────────────────────────
    // Baseado no formato real do app "Minha Escala" da Azul Linhas Aéreas.
    // O PDF tem uma tabela principal com colunas:
    //   Activity | Checkin | Start | End | Checkout | Dep | Arr | AcVer | DD/CAT | Crews
    //
    // A coluna "Crews" contém uma sub-tabela com duas colunas: "Crew" (nome) e "Function" (função).
    // Cada linha da tabela principal representa UMA ATIVIDADE para UM DIA.
    // ────────────────────────────────────────────────────────────────────────────

    const basePrompt = `Você está lendo uma escala do app "Minha Escala" da Azul Linhas Aéreas.

ESTRUTURA DO DOCUMENTO:
A tabela principal tem colunas: Activity | Checkin | Start | End | Checkout | Dep | Arr | AcVer | DD/CAT | Crews
A coluna "Crews" contém uma mini-tabela com colunas "Crew" (nome completo) e "Function" (função: CA, FO, CL, FA, FE, SUP).
As datas aparecem no formato DD/MM/AAAA nas colunas Checkin/Start/End/Checkout.

COMO IDENTIFICAR CADA TIPO DE ATIVIDADE (pela coluna Activity):
- "FR" = Folga Regular → tipo: "fr", label: "Folga"
- "FP" = Folga Programada → tipo: "fp", label: "Folga"  
- "PP" = Folga → tipo: "fp", label: "Folga"
- "SB" seguido de número (ex: SB12) = Sobreaviso → tipo: "sb", label: "Sobreaviso", detalhe: horário início e duração do Checkin/Start/End
- "RHC" ou "RHC22" ou "RHC23" ou qualquer "RHC+número" = RESERVA (não é voo!) → tipo: "rea", label: "Reserva", sem voos
- Código começando com "AD" seguido de números (ex: AD4070, AD2805) = Voo Azul → tipo: "voo"
- Código começando com "G3" seguido de números (ex: G3123) = Voo Gol → tipo: "voo"
- Código começando com "LA" ou "JJ" seguido de números = Voo Latam → tipo: "voo"
- "ADP" = Adaptação → tipo: "adp", label: "Adaptação"
- "Layover" = Pernoite — NÃO é um dia separado, pertence ao dia do voo anterior

REGRA IMPORTANTE — RESERVA vs VOO:
RHC (qualquer variação) = RESERVA. Nunca coloque voos dentro de uma reserva.
Só coloque tipo "voo" quando houver um código de voo real (AD####, G3###, etc.).

REGRA IMPORTANTE — LAYOVER/PERNOITE:
Quando aparecer uma linha "Layover" após um voo, ela indica pernoite no destino do voo anterior.
Adicione o pernoite ao dia do voo anterior com: {"l": "CIDADE/AEROPORTO", "ci": "HH:MM checkin layover", "co": "HH:MM checkout layover"}

REGRA IMPORTANTE — VOOS NO MESMO DIA:
Se houver múltiplos voos com a mesma data (ex: dois "AD####" no dia 09/JUN), agrupe-os no mesmo objeto de dia, em um array "voos".

REGRA IMPORTANTE — TRIPULAÇÃO:
A coluna Crews tem a lista de tripulação. Leia TODOS os nomes e funções da sub-tabela.
Funções possíveis: CA (Comandante), FO (Primeiro Oficial), CL (Comissário Líder), FA (Comissário), FE (Flight Engineer), SUP (Supervisor).
Inclua a tripulação no objeto do dia, no campo "tripulacao".

FORMATO DE SAÍDA — retorne APENAS JSON válido, sem texto antes ou depois:
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
        {"n": "AD4070", "o": "VCP", "d": "REC", "dp": "06:00", "ar": "09:00", "du": "3h00", "ae": "32N"},
        {"n": "AD4071", "o": "REC", "d": "VCP", "dp": "10:00", "ar": "13:00", "du": "3h00", "ae": "32N"}
      ],
      "tripulacao": [
        {"nome": "JOAO SILVA", "funcao": "CA"},
        {"nome": "MARIA SOUZA", "funcao": "FA"}
      ],
      "pernoite": null
    }
  ]
}

CAMPOS DE CADA VOO:
- n: número do voo (ex: "AD4070")
- o: aeroporto origem 3 letras (coluna Dep)
- d: aeroporto destino 3 letras (coluna Arr)
- dp: horário partida HH:MM (coluna Start)
- ar: horário chegada HH:MM (coluna End)
- du: duração calculada entre dp e ar (ex: "3h00")
- ae: aeronave (coluna AcVer, ex: "32N", "32A", "E2", "ATR", "320")

Para dias sem voo (folga, reserva, sb), use voos:[] e tripulacao:[].
Inclua TODOS os dias do mês, mesmo os de folga.`;

    const prompt1 = basePrompt + `

Extraia APENAS os dias 1 a 15 do mês. Retorne somente o JSON.`;

    const prompt2 = basePrompt + `

Extraia APENAS os dias 16 até o final do mês. Retorne somente o JSON com estrutura:
{"dias": [...]}`;

    const [text1, text2] = await Promise.all([
      makeRequest(prompt1),
      makeRequest(prompt2)
    ]);

    // ─── EXTRAÇÃO E REPAIR DE JSON ───────────────────────────────────────────────
    const extractAndRepair = (text) => {
      // Remove possíveis markdown fences
      let clean = text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
      
      const match = clean.match(/\{[\s\S]*\}/);
      if (!match) return null;
      
      try {
        return JSON.parse(match[0]);
      } catch (e) {
        // Tenta reparar JSON truncado
        let t = match[0];
        
        // Remove última vírgula antes de fechar array/objeto
        t = t.replace(/,\s*([}\]])/g, '$1');
        
        // Fecha estruturas abertas
        let opens = 0, objOpens = 0;
        for (let c of t) {
          if (c === '[') opens++;
          else if (c === ']') opens--;
          if (c === '{') objOpens++;
          else if (c === '}') objOpens--;
        }
        while (opens > 0) { t += ']'; opens--; }
        while (objOpens > 0) { t += '}'; objOpens--; }
        
        try { return JSON.parse(t); }
        catch (e2) { return null; }
      }
    };

    const res1 = extractAndRepair(text1);
    const res2 = extractAndRepair(text2);

    if (!res1) {
      return res.status(500).json({ 
        error: 'Não consegui ler os primeiros 15 dias',
        rawText: text1.substring(0, 500)
      });
    }

    // ─── COMBINA OS DOIS BLOCOS ──────────────────────────────────────────────────
    const diasFinal = [...(res1.dias || [])];
    
    if (res2 && res2.dias) {
      res2.dias.forEach(d => {
        if (!diasFinal.find(x => x.dia === d.dia)) {
          diasFinal.push(d);
        }
      });
    }
    
    diasFinal.sort((a, b) => a.dia - b.dia);

    // ─── NORMALIZA CADA DIA ──────────────────────────────────────────────────────
    diasFinal.forEach(d => {
      // Garante arrays existam
      if (!d.voos) d.voos = [];
      if (!d.tripulacao) d.tripulacao = [];
      if (!d.pernoite) d.pernoite = null;
      if (!d.detalhe) d.detalhe = '';
      
      // Normaliza tipo
      if (!d.tipo) {
        if (d.voos && d.voos.length > 0) d.tipo = 'voo';
        else d.tipo = 'fr';
      }
      
      // Garante label
      if (!d.label) {
        const labels = { fr: 'Folga', fp: 'Folga', voo: 'Voo', rea: 'Reserva', sb: 'Sobreaviso', adp: 'Adaptação' };
        d.label = labels[d.tipo] || d.tipo.toUpperCase();
      }
    });

    // ─── CALCULA RESUMO REAL ─────────────────────────────────────────────────────
    const resumo = { voos: 0, pernoites: 0, folgas: 0, sb: 0 };
    diasFinal.forEach(d => {
      if (d.tipo === 'voo') {
        resumo.voos += (d.voos && d.voos.length > 0) ? d.voos.length : 1;
        if (d.pernoite) resumo.pernoites++;
      } else if (d.tipo === 'fr' || d.tipo === 'fp') {
        resumo.folgas++;
      } else if (d.tipo === 'sb') {
        resumo.sb++;
      }
    });

    return res.status(200).json({
      content: [{
        type: 'text',
        text: JSON.stringify({
          mes: res1.mes || 'Junho 2026',
          resumo,
          dias: diasFinal
        })
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
