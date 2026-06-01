exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: 'Method Not Allowed' };
  }

  try {
    const { fileData, mediaType } = JSON.parse(event.body);

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
              type: mediaType.startsWith('image/') ? 'image' : 'document',
              source: { type: 'base64', media_type: mediaType, data: fileData }
            },
            {
              type: 'text',
              text: `Voce e especialista em escalas de tripulantes da aviacao brasileira (Azul, Gol, Latam).

Analise esta escala e retorne APENAS um JSON valido, sem texto antes ou depois, sem markdown.

Formato exato:
{"mes":"Maio 2026","resumo":{"voos":0,"pernoites":0,"folgas":0,"sb":0},"dias":[{"dia":1,"tipo":"fr","label":"Folga","detalhe":""}]}

Regras para identificar cada dia:
- FR = Folga Regular
- FP = Folga Programada  
- SB seguido de numero = Sobreaviso (ex: SB18 = comeca 18:00, calcule horas ate 23:59, coloque no detalhe ex: "18:00 - 6h")
- RHC ou REA = Reserva (vai ao aeroporto)
- AD seguido de numeros = Voo Azul, coloque numero no detalhe
- G3 seguido de numeros = Voo Gol
- LA seguido de numeros = Voo Latam
- Layover = Pernoite fora de casa
- ADP = Adaptacao internacional
- AVN ou Dia Oculto = use tipo fr

IMPORTANTE:
- Identifique o mes e ano corretamente (ex: "Maio 2026", "Junho 2026")
- Agrupe voos do mesmo dia em um unico objeto
- Se um dia tem voo AD1234 e AD5678, coloque detalhe: "AD1234, AD5678"
- Para Layover coloque no detalhe a cidade
- Retorne o JSON completo com todos os dias do mes`
            }
          ]
        }]
      })
    });

    const data = await response.json();
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(data)
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};
