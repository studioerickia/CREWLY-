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
  const AERONAVES = ['ATR','E1','E2','E195','E190','295','290','320','321','32N','32A','32Q','319','330','339','350','763','772'];
  const DIAS_MES = {janeiro:31,fevereiro:29,'março':31,marco:31,abril:30,maio:31,junho:30,julho:31,agosto:31,setembro:30,outubro:31,novembro:30,dezembro:31};

  const distLev = (a,b) => {
    const m=a.length,n=b.length,d=Array.from({length:m+1},(_,i)=>[i,...Array(n).fill(0)]);
    for(let j=0;j<=n;j++)d[0][j]=j;
    for(let i=1;i<=m;i++)for(let j=1;j<=n;j++)
      d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(a[i-1]===b[j-1]?0:1));
    return d[m][n];
  };
  const validarAero = (code) => {
    if(!code) return '--';
    code=String(code).toUpperCase().trim().replace(/[^A-Z0-9]/g,'');
    if(AERO_SET.has(code)) return code;
    let melhor=code,menor=99;
    for(const a of AEROPORTOS){const dd=distLev(code,a);if(dd<menor){menor=dd;melhor=a;}}
    return menor<=1?melhor:code;
  };
  const parseTime=(t)=>{if(!t)return null;const m=String(t).match(/(\d{1,2}):(\d{2})/);if(!m)return null;let x=parseInt(m[1])*60+parseInt(m[2]);if(/\+1/.test(String(t)))x+=1440;return x;};
  const fmtTime=(x)=>{x=((x%1440)+1440)%1440;return`${String(Math.floor(x/60)).padStart(2,'0')}:${String(x%60).padStart(2,'0')}`;};
  const durationStr=(s,e)=>{let a=parseTime(s),b=parseTime(e);if(a==null||b==null)return'';let d=b-a;if(d<0)d+=1440;return`${Math.floor(d/60)}h${String(d%60).padStart(2,'0')}`;};
  const durationHoras=(s,e)=>{let a=parseTime(s),b=parseTime(e);if(a==null||b==null)return 0;let d=b-a;if(d<0)d+=1440;return Math.round(d/60);};
  const subMinutes=(t,mins)=>{let v=parseTime(t);if(v==null)return'';return fmtTime(v-mins);};
  const isIntl=(iata)=>INTL.has((iata||'').toUpperCase());
  const calcApres=(checkin,dep,intl)=>{
    const margin=intl?90:50;const computed=subMinutes(dep,margin);
    const a=parseTime(checkin),d=parseTime(dep);if(a==null||d==null)return computed;
    let gap=d-a;if(gap<0)gap+=1440;if(gap<20||gap>240)return computed;return fmtTime(a);
  };

  try {
    const {fileData,mediaType}=req.body;
    if(!fileData) return res.status(400).json({error:'No file data'});

    // Extrai JPEG do PDF sem biblioteca externa
    const isImage=(mediaType||'').startsWith('image/');
    let imgB64=fileData;
    let imgMediaType=mediaType||'application/pdf';
    let contentType=isImage?'image':'document';

    if(!isImage){
      try{
        const pdf=Buffer.from(fileData,'base64');
        const start=pdf.indexOf(Buffer.from([0xFF,0xD8,0xFF]));
        const end=pdf.lastIndexOf(Buffer.from([0xFF,0xD9]));
        if(start>=0&&end>start){
          imgB64=pdf.slice(start,end+2).toString('base64');
          imgMediaType='image/jpeg';
          contentType='image';
        }
      }catch(e){}
    }

    const callAPI=async(content)=>{
      const r=await fetch('https://api.anthropic.com/v1/messages',{
        method:'POST',
        headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
        body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:8000,messages:[{role:'user',content}]})
      });
      const d=await r.json();
      if(d.error)throw new Error(d.error.message||'API error');
      return(d.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
    };

    // Step 1: transcrição — manda a imagem inteira mas com lista fechada de aeroportos
    const rawText=await callAPI([
      {type:contentType,source:{type:'base64',media_type:imgMediaType,data:imgB64}},
      {type:'text',text:`Você está lendo uma IMAGEM de uma escala da Azul (app "Minha Escala"). É uma foto de tabela — leia com atenção às letras pequenas.

Colunas: Activity | Checkin | Start | End | Checkout | Dep | Arr | AcVer | DD/CAT | Crews
Start e End têm DATA e HORA (ex: "26 JUN 2026 17:55").

REGRA CRÍTICA — AEROPORTOS (Dep/Arr): use SOMENTE um código desta lista:
${AEROPORTOS.join(', ')}
Se o que você vê parece "US", "IS", "L1S" → escolha LIS. Se parece "BE", "BEI" → escolha BEL. NUNCA escreva código fora da lista.

AERONAVES (AcVer): ${AERONAVES.join(', ')}

Para cada linha, gere (separado por |):
DATA_INI | DATA_FIM | ACTIVITY | CHECKIN | START | END | DEP | ARR | ACVER | DDCAT | CREWS

- DATA_INI: data do Start (DD/MM/AAAA). DATA_FIM: data do End (DD/MM/AAAA).
- CHECKIN: hora da coluna Checkin (HH:MM). START: hora da coluna Start (HH:MM). END: hora da coluna End (HH:MM).
- ATENÇÃO: CHECKIN, START e END são 3 colunas diferentes com horários diferentes. Não troque a ordem.
- A coluna Checkin fica ANTES da coluna Start. A coluna Start fica ANTES da coluna End.
- DEP/ARR: aeroporto da lista acima.
- CREWS: NOME:FUNCAO separados por vírgula.

Datas nunca viram horários. Transcreva TODAS as linhas. Responda só as linhas, sem explicação.`}
    ]);

    // Step 2: JSON
    const jsonText=await callAPI([{
      type:'text',
      text:`Converta esta transcrição em JSON. NÃO calcule nada.

TRANSCRIÇÃO (DATA_INI | DATA_FIM | ACTIVITY | CHECKIN | START | END | DEP | ARR | ACVER | DDCAT | CREWS):
${rawText}

CLASSIFICAÇÃO: FR→"fr"; FP/PP→"fp"; FC→"fc"; FA(atividade)→"fa"; SB+nº→"sb"; RHC...→"rea";
ADP→"adp"; ADPOB→"adpob"; AD####/G3###/LA###/JJ###→"voo"; DHD→"voo"+"dhd":true;
Layover→pernoite do dia do voo anterior. NUNCA classifique ADP/ADPOB/FC/FA como "fr".

POR DIA: {"dia":<dia de DATA_INI>,"diaFim":<dia de DATA_FIM>,"tipo":"...","dhd":<bool>,
"checkin":"<CHECKIN do 1º voo>","ddcat":"<DDCAT>","local":"<DEP só adp/adpob>",
"sbInicio":"<START só sb>","sbFim":"<END só sb>",
"voos":[{"n":"<ACTIVITY>","o":"<DEP>","d":"<ARR>","dp":"<START>","ar":"<END>","ae":"<ACVER>"}],
"tripulacao":[{"nome":"<NOME>","funcao":"<FUNCAO>"}],
"pernoite":{"l":"<LOCAL Layover>","ci":"<START layover>","co":"<END layover>"}}

Vários voos na mesma DATA_INI → 1 objeto, todos em "voos". Funções: CA,FO,CL,FA,FE,SUP (COBS→SUP,V→SUP,DHD→DHD).
Dias não-voo: "voos":[] e "tripulacao":[]. NÃO calcule duração nem apresentação.
Responda APENAS: {"mes":"<Mês AAAA>","dias":[...]}`
    }]);

    const extractAndRepair=(text)=>{
      let clean=text.replace(/```json\s*/gi,'').replace(/```\s*/gi,'').trim();
      const match=clean.match(/\{[\s\S]*\}/);if(!match)return null;
      try{return JSON.parse(match[0]);}
      catch(e){
        let t=match[0].replace(/,\s*([}\]])/g,'$1');let o=0,oo=0;
        for(let c of t){if(c==='[')o++;else if(c===']')o--;if(c==='{')oo++;else if(c==='}')oo--;}
        while(o>0){t+=']';o--;}while(oo>0){t+='}';oo--;}
        try{return JSON.parse(t);}catch(e2){return null;}
      }
    };

    const parsed=extractAndRepair(jsonText);
    if(!parsed||!parsed.dias) return res.status(500).json({error:'Falha ao converter JSON',rawExtraction:rawText.substring(0,2000),rawJson:jsonText.substring(0,2000)});

    const mesNome=(parsed.mes||'junho 2026').toLowerCase().split(' ')[0];
    const diasNoMes=DIAS_MES[mesNome]||31;
    const labels={fr:'Folga',fp:'Folga Programada',fc:'Folga Casada',fa:'Folga Aniversário',voo:'Voo',rea:'Reserva',sb:'Sobreaviso',adp:'Adaptação',adpob:'Adaptação fora da base'};

    parsed.dias=parsed.dias.filter(d=>d&&d.dia>=1&&d.dia<=diasNoMes);

    parsed.dias.forEach(d=>{
      d.voos=Array.isArray(d.voos)?d.voos:[];
      d.tripulacao=Array.isArray(d.tripulacao)?d.tripulacao:[];
      d.pernoite=d.pernoite&&d.pernoite.l?d.pernoite:null;
      d.dhd=d.dhd===true;d.detalhe=d.detalhe||'';
      const ddcat=(d.ddcat||'').toUpperCase();
      d.euroAtlantic=ddcat==='COBS'||ddcat==='V';

      if(d.tipo==='voo'&&d.voos.length>0){
        d.voos.forEach(v=>{
          v.n=v.n||'--';v.o=validarAero(v.o);v.d=validarAero(v.d);
          v.dp=v.dp||'--';v.ar=v.ar||'--';v.ae=v.ae||'--';
          v.du=durationStr(v.dp,v.ar)||'--';
        });
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

    return res.status(200).json({content:[{type:'text',text:JSON.stringify({mes:parsed.mes||'Junho 2026',resumo,dias:diasFinal})}]});
  }catch(err){
    console.error('Parser error:',err);
    return res.status(500).json({error:err.message});
  }
};

module.exports.config={api:{bodyParser:{sizeLimit:'15mb'},maxDuration:60}};
