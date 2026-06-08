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

    const response = await fetch('https://api.anthropic.com/v1/messages', {
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
            {
              type: isImage ? 'image' : 'document',
              source: { type: 'base64', media_type: mt, data: fileData }
            },
            {
              type: 'text',
              text: `Analise esta escala de tripulante de aviacao brasileira e retorne APENAS JSON valido sem texto adicional.

O documento pode ser uma escala da Azul (AD), Gol (G3) ou Latam (LA).

Retorne exatamente neste formato:
{"mes":"Junho 2026","resumo":{"voos":0,"pernoites":0,"folgas":0,"sb":0},"dias":[{"dia":1,"tipo":"fr","label":"Folga","detalhe":"","tripulacao":[]}]}

Tipos de atividade:
- fr = FR ou Folga Regular
- fp = FP ou Folga Programada
- sb = SB seguido de horario (ex SB18 = sobreaviso das 18:00, calcule horas ate 23:59, coloque no detalhe "18:00-6h")
- rea = RHC ou REA (reserva, vai ao aeroporto)
- voo = qualquer voo AD/G3/LA (coloque numeros no detalhe ex "AD4070, AD4577")
- adp = ADP (adaptacao internacional)
- pernoite = Layover (nao e dia separado, incluir no dia do voo)

Para cada dia de VOO inclua no campo tripulacao todos os membros listados:
[{"nome":"NOME COMPLETO","funcao":"CA"}]
Funcoes possiveis: CA, FO, CL, FA, FE, SUP

Regras:
- Identifique mes e ano pelas datas
- Agrupe todos os voos do mesmo dia em um unico objeto
- AVN ou Dia Oculto = tipo fr
- Retorne TODOS os dias do mes
- IMPORTANTE: retorne JSON completo mesmo que seja longo`
            }
          ]
        }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(500).json({ error: 'API error: ' + response.status, detail: errText.substring(0, 200) });
    }

    const data = await response.json();

    // Check for API error
    if (data.error) {
      return res.status(500).json({ error: data.error.message || 'API error' });
    }

    // Extract text content
    const text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    if (!text) {
      return res.status(500).json({ error: 'Empty response from AI' });
    }

    // Try to extract JSON
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ error: 'No JSON found in response', preview: text.substring(0, 200) });
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return res.status(200).json({ content: [{ type: 'text', text: JSON.stringify(parsed) }] });
    } catch (e) {
      return res.status(500).json({ error: 'Invalid JSON: ' + e.message, preview: jsonMatch[0].substring(0, 200) });
    }

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

module.exports.config = {
  api: {
    bodyParser: { sizeLimit: '10mb' },
    maxDuration: 30
  }
};
