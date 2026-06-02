export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { fileData, mediaType } = req.body;

    if (!fileData || !mediaType) {
      return res.status(400).json({ error: 'fileData and mediaType are required' });
    }

    const isImage = mediaType.startsWith('image/');
    const contentType = isImage ? 'image' : 'document';

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: [
            {
              type: contentType,
              source: { 
                type: 'base64', 
                media_type: mediaType, 
                data: fileData 
              }
            },
            {
              type: 'text',
              text: `Voce e especialista em escalas de tripulantes da aviacao brasileira (Azul, Gol, Latam).

Analise esta escala e retorne APENAS um JSON valido, sem texto antes ou depois, sem markdown.

Formato exato:
{"mes":"Maio 2026","resumo":{"voos":0,"pernoites":0,"folgas":0,"sb":0},"dias":[{"dia":1,"tipo":"fr","label":"Folga","detalhe":""}]}

Regras:
- FR = Folga Regular (tipo: fr)
- FP = Folga Programada (tipo: fp)
- SB + numero = Sobreaviso (tipo: sb, detalhe: "HH:MM - Xh")
- RHC ou REA = Reserva (tipo: rea)
- AD + numeros = Voo Azul (tipo: voo, detalhe: numero do voo)
- G3 + numeros = Voo Gol (tipo: voo)
- LA + numeros = Voo Latam (tipo: voo)
- Layover = Pernoite (tipo: pernoite, detalhe: cidade)
- ADP = Adaptacao internacional (tipo: adp)
- AVN ou Dia Oculto = tipo fr

IMPORTANTE:
- Identifique mes e ano corretamente
- Agrupe voos do mesmo dia: detalhe "AD1234, AD5678"
- Retorne JSON com TODOS os dias do mes`
            }
          ]
        }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(500).json({ error: 'API error: ' + errText });
    }

    const data = await response.json();
    return res.status(200).json(data);

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
