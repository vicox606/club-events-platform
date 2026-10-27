import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import Razorpay from 'razorpay';
import Database from 'better-sqlite3';
import nodemailer from 'nodemailer';
import QRCode from 'qrcode';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const app=express();
const port=Number(process.env.PORT||4000);
const isProd=process.env.NODE_ENV==='production';
const dbPath=path.resolve(process.env.DATABASE_PATH||'./data/events.sqlite');
fs.mkdirSync(path.dirname(dbPath),{recursive:true});
const db=new Database(dbPath);
db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON'); db.pragma('busy_timeout = 5000');
db.exec(`
CREATE TABLE IF NOT EXISTS users(user_id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT NOT NULL UNIQUE,role TEXT NOT NULL DEFAULT 'participant',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS events(event_id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,date TEXT NOT NULL,fee INTEGER NOT NULL CHECK(fee>=0),capacity INTEGER NOT NULL CHECK(capacity>0),description TEXT DEFAULT '',category TEXT DEFAULT 'Community',published INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS registrations(reg_id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(user_id),event_id INTEGER NOT NULL REFERENCES events(event_id),name TEXT NOT NULL,email TEXT NOT NULL,team_name TEXT DEFAULT '',role TEXT DEFAULT 'Student',txn_ref TEXT UNIQUE,status TEXT NOT NULL DEFAULT 'pending',amount INTEGER NOT NULL,qr_data TEXT,email_sent INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS webhook_events(event_id TEXT PRIMARY KEY,event_type TEXT NOT NULL,payload TEXT NOT NULL,processed INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS admin_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,event_type TEXT NOT NULL,message TEXT NOT NULL,reg_id TEXT,metadata TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_reg_event_status ON registrations(event_id,status); CREATE INDEX IF NOT EXISTS idx_reg_email ON registrations(email); CREATE INDEX IF NOT EXISTS idx_logs_created ON admin_logs(created_at);
`);
const log=(type,message,regId=null,metadata=null)=>db.prepare('INSERT INTO admin_logs(event_type,message,reg_id,metadata) VALUES(?,?,?,?)').run(type,message,regId,metadata?JSON.stringify(metadata):null);
const seeded=db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
if(!seeded){const insert=db.prepare('INSERT INTO events(name,date,fee,capacity,description,category) VALUES(?,?,?,?,?,?)');const rows=[['Creative Club Social','2026-11-08T17:30:00',299,120,'An evening of good people, big ideas, and a little creative chaos.','Community'],['Design After Dark','2026-11-14T18:00:00',499,80,'A hands-on design jam for curious minds and makers.','Workshop'],['Founders & Filter Coffee','2026-11-21T10:00:00',199,60,'Real conversations, early-stage ideas, and excellent coffee.','Networking']];db.transaction(()=>rows.forEach(x=>insert.run(...x)))();}
const razorpay=process.env.RAZORPAY_KEY_ID&&process.env.RAZORPAY_KEY_SECRET?new Razorpay({key_id:process.env.RAZORPAY_KEY_ID,key_secret:process.env.RAZORPAY_KEY_SECRET}):null;
// Email delivery uses Brevo's HTTPS API instead of SMTP.
const brevoApiKey = process.env.BREVO_API_KEY;
const mailer = brevoApiKey ? { sendMail: async ({ from, to, subject, html, attachments = [] }) => {
  const fromValue = String(from || process.env.MAIL_FROM || '').trim();
  const senderMatch = fromValue.match(/^(.*?)\s*<([^<>]+)>$/);
  const sender = senderMatch
    ? { name: senderMatch[1].trim().replace(/^["']|["']$/g, ''), email: senderMatch[2].trim() }
    : { email: fromValue };
  const payload = {
    sender,
    to: [{ email: to }],
    subject,
    htmlContent: html,
    attachment: attachments.map((attachment) => ({
      name: attachment.filename,
      ...(attachment.cid ? { contentId: attachment.cid } : {}),
      content: Buffer.isBuffer(attachment.content)
        ? attachment.content.toString('base64')
        : Buffer.from(String(attachment.content || '')).toString('base64')
    }))
  };
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'api-key': brevoApiKey
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Brevo API error (${response.status}): ${details.slice(0, 500)}`);
  }
  return response.json();
} } : null;
app.set('trust proxy',isProd?1:false);app.use(helmet({crossOriginResourcePolicy:{policy:'cross-origin'},contentSecurityPolicy:false}));app.use(cors({origin:process.env.CLIENT_ORIGIN||'http://localhost:5173'}));
// Razorpay requires the exact raw request body for webhook signature verification.
app.post('/api/webhooks/razorpay',express.raw({type:'application/json',limit:'1mb'}),async(req,res)=>{
 try{if(!process.env.RAZORPAY_WEBHOOK_SECRET)return res.status(503).json({error:'Webhook secret is not configured'});const signature=req.get('x-razorpay-signature')||'';const expected=crypto.createHmac('sha256',process.env.RAZORPAY_WEBHOOK_SECRET).update(req.body).digest('hex');if(signature.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))return res.status(400).json({error:'Invalid webhook signature'});const payload=JSON.parse(req.body.toString('utf8'));const ev=payload.event;const entity=payload.payload?.payment?.entity;const eventId=req.get('x-razorpay-event-id')||crypto.createHash('sha256').update(req.body).digest('hex');const exists=db.prepare('SELECT event_id FROM webhook_events WHERE event_id=?').get(eventId);if(exists)return res.status(200).json({received:true,duplicate:true});db.prepare('INSERT INTO webhook_events(event_id,event_type,payload,processed) VALUES(?,?,?,0)').run(eventId,ev,JSON.stringify(payload));if(ev==='payment.captured'&&entity){const regId=entity.notes?.reg_id||null;let reg=regId?db.prepare('SELECT * FROM registrations WHERE reg_id=?').get(regId):null;if(!reg&&entity.order_id)reg=db.prepare('SELECT * FROM registrations WHERE txn_ref=?').get(entity.order_id);if(reg)await confirmRegistration(reg.reg_id,entity.id,entity.order_id);else log('webhook.unmatched','Captured payment did not match a registration',null,{payment_id:entity.id,order_id:entity.order_id});}else if(ev==='payment.failed'&&entity){const orderId=entity.order_id;db.prepare("UPDATE registrations SET status='failed',updated_at=CURRENT_TIMESTAMP WHERE txn_ref=? AND status='pending'").run(orderId);log('payment.failed','Razorpay payment failed',null,{payment_id:entity.id,order_id:orderId});}db.prepare('UPDATE webhook_events SET processed=1 WHERE event_id=?').run(eventId);log('webhook.received',`Razorpay webhook: ${ev}`);res.json({received:true});}catch(err){console.error('Webhook processing error:',err);res.status(500).json({error:'Webhook processing failed'});}
});
app.use(express.json({limit:'100kb'}));
app.use('/api',rateLimit({windowMs:15*60*1000,limit:180,standardHeaders:true,legacyHeaders:false}));
const adminAuth=(req,res,next)=>{try{const token=(req.get('authorization')||'').replace(/^Bearer\s+/i,'');if(!token||!process.env.JWT_SECRET)throw new Error('Unauthorized');req.admin=jwt.verify(token,process.env.JWT_SECRET);if(req.admin.role!=='admin')throw new Error('Unauthorized');next()}catch{return res.status(401).json({error:'Please sign in again.'})}};
const studentAuth=(req,res,next)=>{try{const token=(req.get('authorization')||'').replace(/^Bearer\s+/i,'');if(!token||!process.env.JWT_SECRET)throw new Error('Unauthorized');const student=jwt.verify(token,process.env.JWT_SECRET,{issuer:'gather-api',audience:'gather-student'});if(student.role!=='student'||typeof student.email!=='string')throw new Error('Unauthorized');req.student=student;next()}catch{return res.status(401).json({error:'Please sign in again.'})}};
const eventShape=z.object({name:z.string().trim().min(2).max(120),date:z.string().min(10).max(40),fee:z.coerce.number().int().min(0).max(10000000),capacity:z.coerce.number().int().min(1).max(1000000),description:z.string().max(1000).optional().default(''),category:z.string().max(40).optional().default('Community')});
const toEvent=e=>({...e,registered:db.prepare("SELECT COUNT(*) AS n FROM registrations WHERE event_id=? AND status='confirmed'").get(e.event_id).n});
app.get('/api/health',(req,res)=>res.json({ok:true,service:'gather-api',time:new Date().toISOString()}));
app.get('/api/events',(req,res)=>res.json({events:db.prepare('SELECT * FROM events WHERE published=1 ORDER BY date ASC').all().map(toEvent)}));
app.post('/api/registrations/order',async(req,res)=>{try{const schema=z.object({event_id:z.coerce.number().int().positive(),name:z.string().trim().min(2).max(120),email:z.string().trim().email().max(254),team:z.string().max(120).optional().default(''),role:z.enum(['Student','Alumni','Guest','Team']).default('Student')});const data=schema.parse(req.body);const event=db.prepare('SELECT * FROM events WHERE event_id=? AND published=1').get(data.event_id);if(!event)return res.status(404).json({error:'This event is no longer available.'});const registered=db.prepare("SELECT COUNT(*) n FROM registrations WHERE event_id=? AND status IN ('confirmed','pending')").get(event.event_id).n;if(registered>=event.capacity)return res.status(409).json({error:'Sorry, this event is full.'});const email=data.email.toLowerCase();let user=db.prepare('SELECT * FROM users WHERE email=?').get(email);if(!user){const info=db.prepare('INSERT INTO users(email,role) VALUES(?,?)').run(email,'participant');user={user_id:info.lastInsertRowid,email};}const regId='REG-'+crypto.randomBytes(5).toString('hex').toUpperCase();if(event.fee===0){db.prepare("INSERT INTO registrations(reg_id,user_id,event_id,name,email,team_name,role,amount,status) VALUES(?,?,?,?,?,?,?,?, 'confirmed')").run(regId,user.user_id,event.event_id,data.name,email,data.team,data.role,0);await deliverPass(regId);log('registration.confirmed','Free registration confirmed',regId);return res.json({demo:true,reg_id:regId,status:'confirmed'});}if(!razorpay){return res.json({demo:true,reg_id:regId,status:'demo',message:'Razorpay credentials are not configured. No payment was taken.'});}const order=await razorpay.orders.create({amount:event.fee*100,currency:'INR',receipt:regId,notes:{reg_id:regId,event_id:String(event.event_id)}});db.prepare("INSERT INTO registrations(reg_id,user_id,event_id,name,email,team_name,role,txn_ref,amount,status) VALUES(?,?,?,?,?,?,?,?,?,'pending')").run(regId,user.user_id,event.event_id,data.name,email,data.team,data.role,order.id,event.fee);log('payment.order_created','Razorpay order created',regId,{order_id:order.id,amount:event.fee});res.json({order_id:order.id,reg_id:regId,key_id:process.env.RAZORPAY_KEY_ID,amount:order.amount,currency:order.currency});}catch(err){if(err instanceof z.ZodError)return res.status(400).json({error:err.issues[0]?.message||'Please check your details.'});console.error(err);res.status(500).json({error:'Could not start registration. Please try again.'});}});
app.post('/api/registrations/verify',async(req,res)=>{try{const {razorpay_order_id,razorpay_payment_id,razorpay_signature,reg_id}=req.body||{};if(![razorpay_order_id,razorpay_payment_id,razorpay_signature,reg_id].every(x=>typeof x==='string'&&x.length>0))return res.status(400).json({error:'Missing payment verification fields.'});if(!process.env.RAZORPAY_KEY_SECRET)return res.status(503).json({error:'Payment verification is not configured.'});const expected=crypto.createHmac('sha256',process.env.RAZORPAY_KEY_SECRET).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');if(expected.length!==razorpay_signature.length||!crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(razorpay_signature)))return res.status(400).json({error:'Payment signature could not be verified.'});const reg=db.prepare('SELECT * FROM registrations WHERE reg_id=?').get(reg_id);if(!reg||reg.txn_ref!==razorpay_order_id)return res.status(404).json({error:'Registration not found for this payment.'});await confirmRegistration(reg_id,razorpay_payment_id,razorpay_order_id);res.json({ok:true,status:'confirmed'});}catch(err){console.error(err);res.status(500).json({error:'Could not verify payment.'});}});
async function confirmRegistration(regId,paymentId,orderId){const reg=db.prepare('SELECT * FROM registrations WHERE reg_id=?').get(regId);if(!reg)return;if(reg.status!=='confirmed'){db.prepare("UPDATE registrations SET status='confirmed',txn_ref=?,updated_at=CURRENT_TIMESTAMP WHERE reg_id=?").run(paymentId,regId);log('payment.confirmed','Payment verified and registration confirmed',regId,{payment_id:paymentId,order_id:orderId});}await deliverPass(regId);}
async function deliverPass(regId){const reg=db.prepare('SELECT r.*,e.name AS event_name,e.date AS event_date,e.fee AS event_fee FROM registrations r JOIN events e ON e.event_id=r.event_id WHERE r.reg_id=?').get(regId);if(!reg||reg.status!=='confirmed')return;const qrPayload=JSON.stringify({reg_id:reg.reg_id,event_id:reg.event_id,email:reg.email,checkin:'gather-entry'});db.prepare('UPDATE registrations SET qr_data=? WHERE reg_id=?').run(qrPayload,regId);if(!mailer){log('email.skipped','BREVO_API_KEY not configured; pass email not sent',regId);return;}try{const qr=await QRCode.toDataURL(qrPayload,{width:340,margin:1,errorCorrectionLevel:'M'});const qrBuffer=Buffer.from(qr.split(',')[1],'base64');await mailer.sendMail({from:process.env.MAIL_FROM||'Gather Events <noreply@example.com>',to:reg.email,subject:`Your entry pass: ${reg.event_name}`,html:`<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#173c43"><div style="background:#16856f;color:#fff;padding:20px 24px;border-radius:12px 12px 0 0"><b style="font-size:22px">gather.</b><span style="float:right;background:#d7f2e2;color:#176b57;border-radius:20px;padding:6px 10px;font-size:12px">CONFIRMED</span></div><div style="border:1px solid #e5e5dd;border-top:0;padding:26px;border-radius:0 0 12px 12px"><p style="font-size:11px;color:#81908b;letter-spacing:1px">YOUR EVENT PASS</p><h1 style="margin:6px 0 20px">${escapeHtml(reg.event_name)}</h1><p><b>Participant</b><br>${escapeHtml(reg.name)}${reg.team_name?' · '+escapeHtml(reg.team_name):''}</p><p><b>Date</b><br>${escapeHtml(new Date(reg.event_date).toLocaleString('en-IN',{dateStyle:'full',timeStyle:'short'}))}</p><p><b>Registration ID</b><br>${escapeHtml(reg.reg_id)}</p><p><b>Transaction reference</b><br>${escapeHtml(reg.txn_ref||'FREE')}</p><div style="text-align:center;padding:15px"><img alt="QR entry pass" width="220" height="220" src="cid:gatherqr"/><p style="font-size:12px;color:#7d8985">Show this QR code at the venue entrance.</p></div></div></div>`,attachments:[{filename:'gather-entry-qr.png',content:qrBuffer,cid:'gatherqr'}]});db.prepare('UPDATE registrations SET email_sent=1 WHERE reg_id=?').run(regId);log('email.sent','QR entry pass emailed',regId,{email:reg.email});}catch(err){console.error('Email delivery failed',err);log('email.failed','QR pass email delivery failed',regId,{error:err.message});}}
function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
app.post('/api/admin/login',rateLimit({windowMs:15*60*1000,limit:8,standardHeaders:true,legacyHeaders:false}),async(req,res)=>{const {email,password}=req.body||{};if(!process.env.ADMIN_EMAIL||!process.env.ADMIN_PASSWORD||!process.env.JWT_SECRET)return res.status(503).json({error:'Admin login is not configured. Set ADMIN_EMAIL, ADMIN_PASSWORD, and JWT_SECRET.'});const a=String(email||'').toLowerCase()===process.env.ADMIN_EMAIL.toLowerCase();const b=String(password||'')===process.env.ADMIN_PASSWORD;if(!a||!b){log('admin.login_failed','Invalid admin login attempt');return res.status(401).json({error:'Email or password is incorrect.'});}const token=jwt.sign({role:'admin',email:process.env.ADMIN_EMAIL},process.env.JWT_SECRET,{expiresIn:'8h',issuer:'gather-api',audience:'gather-admin'});log('admin.login','Admin signed in');res.json({token});});
app.post('/api/student/login',rateLimit({windowMs:15*60*1000,limit:8,standardHeaders:true,legacyHeaders:false}),(req,res)=>{const {email,password}=req.body||{};if(!process.env.STUDENT_EMAIL||!process.env.STUDENT_PASSWORD||!process.env.JWT_SECRET)return res.status(503).json({error:'Student login is not configured. Set STUDENT_EMAIL, STUDENT_PASSWORD, and JWT_SECRET.'});const studentEmail=process.env.STUDENT_EMAIL.trim().toLowerCase();const validEmail=String(email||'').trim().toLowerCase()===studentEmail;const validPassword=String(password||'')===process.env.STUDENT_PASSWORD;if(!validEmail||!validPassword){log('student.login_failed','Invalid student login attempt');return res.status(401).json({error:'Email or password is incorrect.'});}const token=jwt.sign({role:'student',email:studentEmail},process.env.JWT_SECRET,{expiresIn:'8h',issuer:'gather-api',audience:'gather-student'});log('student.login','Student signed in');res.json({token,email:studentEmail});});
app.get('/api/student/passes',studentAuth,(req,res)=>{const passes=db.prepare(`SELECT r.reg_id,r.name,r.email,r.status,r.amount,r.created_at,e.name AS event_name,e.date AS event_date FROM registrations r JOIN events e ON e.event_id=r.event_id WHERE r.email=? ORDER BY r.created_at DESC`).all(req.student.email);res.json({email:req.student.email,passes});});
app.get('/api/admin/overview',adminAuth,(req,res)=>{const regs=db.prepare(`SELECT r.reg_id,r.name,r.email,r.team_name,r.txn_ref,r.status,r.amount,r.email_sent,r.created_at,e.name AS event_name FROM registrations r JOIN events e ON e.event_id=r.event_id ORDER BY r.created_at DESC LIMIT 250`).all();const logs=db.prepare('SELECT * FROM admin_logs ORDER BY created_at DESC LIMIT 100').all();const events=db.prepare('SELECT * FROM events ORDER BY date ASC').all().map(toEvent);res.json({events,registrations:regs,logs});});
app.post('/api/admin/events',adminAuth,(req,res)=>{const parsed=eventShape.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:parsed.error.issues[0]?.message||'Invalid event details.'});const d=parsed.data;const info=db.prepare('INSERT INTO events(name,date,fee,capacity,description,category) VALUES(?,?,?,?,?,?)').run(d.name,d.date,d.fee,d.capacity,d.description,d.category);const event=toEvent(db.prepare('SELECT * FROM events WHERE event_id=?').get(info.lastInsertRowid));log('event.created',`Published event: ${event.name}`);res.status(201).json({event});});
app.patch('/api/admin/events/:id',adminAuth,(req,res)=>{const old=db.prepare('SELECT * FROM events WHERE event_id=?').get(Number(req.params.id));if(!old)return res.status(404).json({error:'Event not found.'});const parsed=eventShape.partial().safeParse(req.body);if(!parsed.success)return res.status(400).json({error:'Invalid event details.'});const d={...old,...parsed.data};db.prepare('UPDATE events SET name=?,date=?,fee=?,capacity=?,description=?,category=? WHERE event_id=?').run(d.name,d.date,d.fee,d.capacity,d.description,d.category,old.event_id);log('event.updated',`Updated event: ${d.name}`);res.json({event:toEvent(db.prepare('SELECT * FROM events WHERE event_id=?').get(old.event_id))});});
app.get('/api/admin/logs',adminAuth,(req,res)=>res.json({logs:db.prepare('SELECT * FROM admin_logs ORDER BY created_at DESC LIMIT 250').all()}));
app.post('/api/admin/registrations/:id/resend-pass',adminAuth,async(req,res)=>{const reg=db.prepare('SELECT * FROM registrations WHERE reg_id=?').get(req.params.id);if(!reg)return res.status(404).json({error:'Registration not found.'});if(reg.status!=='confirmed')return res.status(409).json({error:'Only confirmed registrations have an entry pass.'});await deliverPass(reg.reg_id);res.json({ok:true,email_sent:!!db.prepare('SELECT email_sent FROM registrations WHERE reg_id=?').get(reg.reg_id).email_sent});});
app.get('/', (req, res) => {
  res.json({
    service: 'Gather API',
    health: '/api/health'
  });
});
app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:'Unexpected server error.'});});
app.listen(port,()=>console.log(`Gather API listening on :${port}`));
