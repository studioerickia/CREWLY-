module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const AEROPORTOS = ['VCP','GRU','CGH','SDU','GIG','BSB','CNF','CWB','POA','FLN','NVT','JOI',
    'REC','SSA','FOR','NAT','JPA','MCZ','AJU','THE','SLZ','BEL','MAO','PVH','RBR','BVB','MCP',
    'CGB','CGR','GYN','UDI','RAO','SJP','BAU','MGF','LDB','IGU','XAP','PFB','CXJ','PET','IJU',
    'VIX','IPN','GVR','MOC','UNA','IOS','PHB','PNZ','JDO','IMP','PMW','ARU','DOU','BPS','STM',
    'VDC','CZS','LIS','OPO','FLL','MCO','MIA','JFK','PUJ','SCL','MVD','EZE','AEP','ASU'];
  const AERO_SET = new Set(AEROPORTOS);
  const INTL = new Set(['LIS','OPO','FLL','MCO','MIA','JFK','PUJ','SCL','MVD','EZE','AEP','ASU']);
  const DIAS_MES = {janeiro:31,fevereiro:29,'março':31,marco:31,abril:30,maio:31,junho:30,julho:31,agosto:31,setembro:30,outubro:31,novembro:30,dezembro:31};

  const distLev=(a,b)=>{const m=a.length,n=b.length,d=Array.from({length:m+1},(_,i)=>[i,...Array(n).fill(0)]);for(let j=0;j<=n;j++)d[0][j]=j;for(let i=1;i<=m;i++)for(let j=1;j<=n;j++)d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(a[i-1]===b[j-1]?0:1));return d[m][n];};
  const validarAero=(c)=>{if(!c)return'--';c=String(c).toUpperCase().trim().replace(/[^A-Z0-9]/g,'');if(AERO_SET.has(c))return c;let b=c,n=99;for(const a of AEROPORTOS){const d=distLev(c,a);if(d<n){n=d;b=a;}}return n<=1?b:c;};
  const parseTime=(t)=>{if(!t)return null;const m=String(t).match(/(\d{1,2}):(\d{2})/);if(!m)return null;let x=parseInt(m[1])*60+parseInt(m[2]);if(/\+1/.test(String(t)))x+=1440;return x;};
  const fmtTime=(x)=>{x=((x%1440)+1440)%1440;return`${String(Math.floor(x/60)).padStart(2,'0')}:${String(x%60).padStart(2,'0')}`;};
  const durationStr=(s,e)=>{let a=parseTime(s),b=parseTime(e);if(a==null||b==null)return'';let d=b-a;if(d<0)d+=1440;return`${Math.floor(d/60)}h${String(d%60).padStart(2,'0')}`;};
  const durationHoras=(s,e)=>{let a=parseTime(s),b=parseTime(e);if(a==null||b==null)return 0;let d=b-a;if(d<0)d+=1440;return Math.round(d/60);};
  const subMinutes=(t,m)=>{let v=parseTime(t);if(v==null)return'';return fmtTime(v-m);};
  const isIntl=(i)=>INTL.has((i||'').toUpperCase());
  const calcApres=(checkin,dep,intl)=>{const margin=intl?90:50;const computed=subMinutes(dep,margin);const a=parseTime(checkin),d=parseTime(dep);if(a==null||d==null)return computed;let gap=d-a;if(gap<0)gap+=1440;if(gap<20||gap>240)return computed;return fmtTime(a);};

  const callClaude = async (content, maxTokens=4000) => {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
      body: JSON.stringify({model:'claude-sonnet-4-6',max_tokens:maxTokens,messages:[{role:'user',content}]})
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    return (d.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
  };

  const PROMPT = `Transcreva esta parte de uma escala de voo da Azul Linhas Aéreas.
Colunas: Activity | Checkin | Start | End | Checkout | Dep | Arr | AcVer | DD/CAT | Crews
- Checkin = apresentação. Start = DECOLAGEM. End = POUSO. São 3 horários DIFERENTES!
- Aeroportos válidos: ${AEROPORTOS.join(',')}
- Se ver "US" = LIS

Formato: DATA_INI | DATA_FIM | ACTIVITY | CHECKIN | START | END | DEP | ARR | ACVER | DDCAT | CREWS
- DATA_INI e DATA_FIM: apenas DD/MM/AAAA (nunca inclua a hora na data)
- CHECKIN/START/END: apenas HH:MM
- CREWS: NOME:FUNCAO por vírgula
Transcreva TODAS as linhas visíveis. Responda só as linhas.`;

  try {
    const {fileData, mediaType, strips} = req.body;
    if (!fileData) return res.status(400).json({error:'No file data'});

    const isImage = (mediaType||'').startsWith('image/');
    let imgB64 = fileData;
    if (!isImage) {
      try {
        const pdf = Buffer.from(fileData,'base64');
        const s = pdf.indexOf(Buffer.from([0xFF,0xD8,0xFF]));
        const e = pdf.lastIndexOf(Buffer.from([0xFF,0xD9]));
        if (s>=0 && e>s) imgB64 = pdf.slice(s,e+2).toString('base64');
      } catch(e) {}
    }

    let stripsArr = [];
    if (strips && strips.length >= 3) {
      stripsArr = strips;
      console.log('Strips do navegador:', strips.length, strips.map(s=>Math.round(s.length/1024)+'KB').join(', '));
    } else {
      stripsArr = [imgB64];
      console.log('Sem strips, usando imagem inteira');
    }

    // STEP 1: transcreve cada strip
    const transcricoes = await Promise.all(
      stripsArr.map((s, i) =>
        callClaude([
          {type:'image', source:{type:'base64', media_type:'image/jpeg', data:s}},
          {type:'text', text:PROMPT}
        ], 4000)
        .then(t => { console.log(`Strip ${i+1}: ${t.length} chars`); return t; })
        .catch(e => { console.log(`Strip ${i+1} erro:`, e.message); return ''; })
      )
    );

    const rawText = transcricoes.filter(Boolean).join('\n');
    console.log('Total chars:', rawText.length);

    // STEP 2: converte para JSON
    const jsonText = await callClaude([{type:'text', text:`Converta esta transcrição de escala da Azul em JSON. NÃO calcule nada.

TRANSCRIÇÃO:
${rawText.substring(0,14000)}

CLASSIFICAÇÃO: FR→"fr"; FP/PP→"fp"; FC→"fc"; FA(atividade)→"fa"; SB+nº→"sb"; RHC...→"rea"; SEA→"rea";
ADP→"adp"; ADPOB→"adpob"; AD####/G3###/LA###/JJ###→"voo"; DHD→"voo"+"dhd":true;
Layover→pernoite do dia do voo anterior. NUNCA classifique ADP/ADPOB/FC/FA/SEA como "fr".
Linhas duplicadas → use só uma vez.

POR DIA: {"dia":<dia DATA_INI>,"diaFim":<dia DATA_FIM>,"tipo":"...","dhd":<bool>,
"checkin":"<CHECKIN 1º voo>","ddcat":"<DDCAT>","local":"<DEP só adp/adpob>",
"sbInicio":"<START sb>","sbFim":"<END sb>",
"voos":[{"n":"<ACTIVITY>","o":"<DEP>","d":"<ARR>","dp":"<START>","ar":"<END>","ae":"<ACVER>"}],
"tripulacao":[{"nome":"<NOME>","funcao":"<FUNCAO>"}],
"pernoite":{"l":"<LOCAL>","ci":"<START layover>","co":"<END layover>"}}

Vários voos mesma DATA_INI → 1 objeto. Funções: CA,FO,CL,FA,FE,SUP.
Dias não-voo: voos:[] e tripulacao:[].
Responda APENAS: {"mes":"<Mês AAAA>","dias":[...]}`}], 8000);

    console.log('Step 2 chars:', jsonText.length);

    // Parse JSON
    const extractAndRepair=(t)=>{
      let c=t.replace(/```json\s*/gi,'').replace(/```\s*/gi,'').trim();
      const m=c.match(/\{[\s\S]*\}/);
      if(!m) return null;
      try{return JSON.parse(m[0]);}
      catch(e){
        let x=m[0].replace(/,\s*([}\]])/g,'$1');
        let o=0,oo=0;
        for(let ch of x){if(ch==='[')o++;else if(ch===']')o--;if(ch==='{')oo++;else if(ch==='}')oo--;}
        while(o>0){x+=']';o--;}while(oo>0){x+='}';oo--;}
        try{return JSON.parse(x);}catch(e2){return null;}
      }
    };

    const parsed = extractAndRepair(jsonText);
    if (!parsed||!parsed.dias) {
      console.log('Falha JSON. jsonText amostra:', jsonText.substring(0,300));
      return res.status(500).json({error:'Falha JSON', jsonSample:jsonText.substring(0,500)});
    }

    console.log('Dias parseados:', parsed.dias.length);

    const mesNome=(parsed.mes||'junho 2026').toLowerCase().split(' ')[0];
    const diasNoMes=DIAS_MES[mesNome]||31;
    const labels={fr:'Folga',fp:'Folga Programada',fc:'Folga Casada',fa:'Folga Aniversário',voo:'Voo',rea:'Reserva',sb:'Sobreaviso',adp:'Adaptação',adpob:'Adaptação fora da base'};

    // Normaliza campo dia: converte "08/06/2026" → 8
    parsed.dias = parsed.dias.map(d => {
      if (!d) return d;
      if (typeof d.dia === 'string' && d.dia.includes('/')) {
        d.dia = parseInt(d.dia.split('/')[0]) || 0;
      } else {
        d.dia = parseInt(d.dia) || 0;
      }
      if (typeof d.diaFim === 'string' && d.diaFim.includes('/')) {
        d.diaFim = parseInt(d.diaFim.split('/')[0]) || d.dia;
      } else {
        d.diaFim = parseInt(d.diaFim) || d.dia;
      }
      return d;
    });
    parsed.dias=parsed.dias.filter(d=>d&&d.dia>=1&&d.dia<=diasNoMes);
    parsed.dias.forEach(d=>{
      d.voos=Array.isArray(d.voos)?d.voos:[];
      d.tripulacao=Array.isArray(d.tripulacao)?d.tripulacao:[];
      d.pernoite=d.pernoite&&d.pernoite.l?d.pernoite:null;
      d.dhd=d.dhd===true;d.detalhe=d.detalhe||'';
      const ddcat=(d.ddcat||'').toUpperCase();
      d.euroAtlantic=ddcat==='COBS'||ddcat==='V';
      if(d.tipo==='voo'&&d.voos.length>0){
        d.voos.forEach(v=>{v.n=v.n||'--';v.o=validarAero(v.o);v.d=validarAero(v.d);v.dp=v.dp||'--';v.ar=v.ar||'--';v.ae=v.ae||'--';v.du=durationStr(v.dp,v.ar)||'--';});
        const first=d.voos[0];
        const intl=d.voos.some(v=>isIntl(v.o)||isIntl(v.d))||d.euroAtlantic;
        d.apres=calcApres(d.checkin,first.dp,intl);
        d.apresLocal=first.o;
        if(d.pernoite){d.pernoite.l=validarAero(d.pernoite.l);d.pernoite.int=isIntl(d.pernoite.l);}
      }
      if(d.tipo==='sb'){
        const ini=d.sbInicio||'12:00';const fim=d.sbFim||'';
        const horas=fim?durationHoras(ini,fim):12;
        d.sbInicio=ini;d.sbFim=fim||fmtTime(parseTime(ini)+horas*60);
        d.sbHoras=horas;d.detalhe=`${d.sbInicio} - ${horas}h`;
      }
      if(d.tipo==='adp'||d.tipo==='adpob'){
        const loc=d.local?validarAero(d.local):'';
        d.info=labels[d.tipo]+(loc?` · ${loc}`:'');d.detalhe=d.info;
      }
      d.label=labels[d.tipo]||d.tipo;
    });

    const porDia={};
    parsed.dias.forEach(d=>{if(!porDia[d.dia]||porDia[d.dia].tipo!=='voo')porDia[d.dia]=d;});
    parsed.dias.forEach(d=>{
      if((d.tipo==='adp'||d.tipo==='adpob')&&d.diaFim&&d.diaFim>d.dia){
        const fim=Math.min(d.diaFim,diasNoMes);
        for(let k=d.dia+1;k<=fim;k++){
          const ex=porDia[k];
          if(!ex||ex.tipo==='fr'||ex.tipo==='fp')
            porDia[k]={dia:k,tipo:d.tipo,label:d.label,detalhe:d.detalhe,info:d.info,dhd:false,euroAtlantic:false,voos:[],tripulacao:[],pernoite:null};
        }
      }
    });

    const diasFinal=[];
    for(let i=1;i<=diasNoMes;i++) diasFinal.push(porDia[i]||{dia:i,tipo:'fr',label:'Folga',detalhe:'',dhd:false,euroAtlantic:false,voos:[],tripulacao:[],pernoite:null});

    const resumo={voos:0,pernoites:0,folgas:0,sb:0};
    diasFinal.forEach(d=>{
      if(d.tipo==='voo'){resumo.voos+=d.voos.length||1;if(d.pernoite)resumo.pernoites++;}
      else if(['fr','fp','fc','fa'].includes(d.tipo))resumo.folgas++;
      else if(d.tipo==='sb')resumo.sb++;
    });

    console.log('Resumo:', JSON.stringify(resumo));
    return res.status(200).json({content:[{type:'text',text:JSON.stringify({mes:parsed.mes||'Junho 2026',resumo,dias:diasFinal})}], rawText: rawText.substring(0,8000)});

 } catch(err) {
    console.error('Parser error:', err.message);
    return res.status(500).json({success:false,errorCode:'PARSER_ERROR',message:'Erro interno ao processar a escala.',details:err.message||'Erro desconhecido',rawText:''});
  }
};
module.exports.config = {
  api: {
    bodyParser: {
      sizeLimit: '50mb'
    },
    maxDuration: 120
  }
};

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '50mb'
    }
  }
};
