const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 10000;
const SITE_PASSWORD = process.env.SITE_PASSWORD || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

const openai = OPENAI_API_KEY ? new OpenAI.OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

app.use('/api', (req,res,next)=>{
  if(req.headers['x-site-password'] !== SITE_PASSWORD) return res.status(401).json({error:'Unauthorized'});
  next();
});

app.get('/api/cards', async (req,res)=>{
  try {
    const type = (req.query.type||'sales').toLowerCase();
    const table = type==='ops' ? 'ops_cards' : 'sales_cards';
    const { data, error } = await supabase.from(table).select('*').order('created_at',{ascending:false}).limit(5);
    if(error) throw error;
    res.json({ source: table, cards: data||[] });
  } catch (e) {
    res.status(500).json({error:'Supabase query failed'});
  }
});

app.post('/api/coach', async (req,res)=>{
  try {
    const { prompt } = req.body||{};
    if(!prompt) return res.status(400).json({error:'Missing prompt'});
    if(!openai) return res.json({reply:'AI not configured yet.'});
    const completion = await openai.chat.completions.create({
      model:'gpt-4o-mini',
      messages:[
        {role:'system',content:'You are Fr8Coach, a freight brokerage sales & ops coach. Be concise and practical.'},
        {role:'user',content: prompt}
      ]
    });
    res.json({reply: completion.choices?.[0]?.message?.content || 'No reply'});
  } catch (e) {
    res.status(500).json({error:'OpenAI call failed'});
  }
});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public/index.html')));

app.listen(PORT, ()=>console.log(`Fr8Coach running on port ${PORT}`));
