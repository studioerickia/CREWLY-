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
          model: 'claude-haiku-4-5-20251001',
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

    // Primeira chamada: estrutura geral + dias 1-15
    const prompt1 = `Analise esta escala de tripulante de aviacao brasileira.

Retorne APENAS JSON valido sem texto:
{"mes":"Junho 2026","resumo":{"voos":0,"pernoites":0,"folgas":0,"sb":0},"dias":[{"dia":1,"tipo":"fr","label":"Folga","detalhe":"","tripulacao":[]}]}

Tipos: fr=Folga Regular, fp=Folga Programada, sb=Sobreaviso(detalhe:"HH:MM-Xh"), rea=RHC/REA, voo=AD/G3/LA(detalhe:numeros), adp=ADP, pernoite=Layover incluir no dia do voo.

Para VOO: tripulacao=[{"nome":"NOME","funcao":"CA"}] com funcoes CA/FO/CL/FA/FE/SUP.

RETORNE APENAS OS DIAS 1 A 15 DO MES. Identifique mes e ano pelas datas.`;

    // Segunda chamada: dias 16-31
    const prompt2 = `Analise esta escala de tripulante de aviacao brasileira.

Retorne APENAS JSON valido sem texto:
{"dias":[{"dia":16,"tipo":"fr","label":"Folga","detalhe":"","tripulacao":[]}]}

Tipos: fr=Folga Regular, fp=Folga Programada, sb=Sobreaviso(detalhe:"HH:MM-Xh"), rea=RHC/REA, voo=AD/G3/LA(detalhe:numeros), adp=ADP, pernoite=Layover incluir no dia do voo.

Para VOO: tripulacao=[{"nome":"NOME","funcao":"CA"}] com funcoes CA/FO/CL/FA/FE/SUP.

RETORNE APENAS OS DIAS 16 AO FINAL DO MES.`;

    // Faz as duas chamadas em paralelo
    const [text1, text2] = await Promise.all([
      makeRequest(prompt1),
      makeRequest(prompt2)
    ]);

    const extractJSON = (text) => {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try { return JSON.parse(match[0]); }
      catch(e) {
        // Tenta reparar JSON truncado
        let t = match[0];
        const lastObj = t.lastIndexOf('},');
        if (lastObj > 0) t = t.substring(0, lastObj + 1);
        let opens = 0, objOpens = 0;
        for (let c of t) {
          if (c === '[') opens++;
          else if (c === ']') opens--;
          else if (c === '{') objOpens++;
          else if (c === '}') objOpens--;
        }
        while (opens > 0) { t += ']'; opens--; }
        while (objOpens > 0) { t += '}'; objOpens--; }
        try { return JSON.parse(t); } catch(e2) { return null; }
      }
    };

    const res1 = extractJSON(text1);
    const res2 = extractJSON(text2);

    if (!res1) {
      return res.status(500).json({ error: 'Nao consegui ler os primeiros dias da escala' });
    }

    // Combina os resultados
    const diasFinal = [...(res1.dias || [])];
    if (res2 && res2.dias) {
      res2.dias.forEach(d => {
        if (!diasFinal.find(x => x.dia === d.dia)) {
          diasFinal.push(d);
        }
      });
    }
    diasFinal.sort((a, b) => a.dia - b.dia);

    // Recalcula resumo
    const resumo = { voos: 0, pernoites: 0, folgas: 0, sb: 0 };
    diasFinal.forEach(d => {
      if (d.tipo === 'voo') { resumo.voos++; }
      else if (d.tipo === 'fr' || d.tipo === 'fp') resumo.folgas++;
      else if (d.tipo === 'sb') resumo.sb++;
    });

    const resultado = {
      mes: res1.mes || 'Junho 2026',
      resumo,
      dias: diasFinal
    };

    return res.status(200).json({
      content: [{ type: 'text', text: JSON.stringify(resultado) }]
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

module.exports.config = {
  api: {
    bodyParser: { sizeLimit: '10mb' },
    maxDuration: 60
  }
};
