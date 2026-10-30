import * as fs from 'node:fs';
import * as path from 'node:path';
import { hostname } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import type { SubAgentInfo } from './sub-agent-session';

/** Durable inspection of existing children, not a second task executor. */
export class SubAgentJournal {
  private readonly directory:string;
  constructor(root:string) {this.directory=path.join(root,'data/subagents');}
  record(parent:string,info:SubAgentInfo):void {
    fs.mkdirSync(this.directory,{recursive:true,mode:0o700});
    const file=this.file(info.id),tmp=file+'.'+randomUUID()+'.tmp';
    try {fs.writeFileSync(tmp,JSON.stringify({version:1,parent,pid:process.pid,host:hostname(),info:{...info,progressLog:info.progressLog.slice(-50)}})+'\n',{mode:0o600});fs.renameSync(tmp,file);}
    finally{fs.rmSync(tmp,{force:true});}
  }
  list(parent:string):SubAgentInfo[] {
    if(!fs.existsSync(this.directory))return [];
    const records = fs.readdirSync(this.directory).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).flatMap(name=>{
      const record=JSON.parse(fs.readFileSync(path.join(this.directory,name),'utf8')),info=record.info as SubAgentInfo;
      if(record.version!==1 || typeof record.parent!=='string' || typeof record.host!=='string' || !Number.isSafeInteger(record.pid) || record.pid<1
        || !info || typeof info.id!=='string' || name!==path.basename(this.file(info.id)) || typeof info.taskDescription!=='string' || !Array.isArray(info.progressLog) || !Array.isArray(info.outputFiles)
        || !['running','waiting_for_input','completed','failed','stopped'].includes(info.status))throw new Error('SUBAGENT_JOURNAL_INVALID');
      if(info.resultNotice && (typeof info.resultNotice.id!=='string' || !info.resultNotice.id
        || info.resultNotice.handledAt!==undefined && !Number.isFinite(info.resultNotice.handledAt)))throw new Error('SUBAGENT_JOURNAL_INVALID');
      if(record.parent!==parent)return [];
      return [record];
    });
    // A received result can still be material for a report whose other work is
    // unfinished. Keep it until the parent has no active or unreceived work.
    const hasOpenWork = records.some(record => ['running', 'waiting_for_input'].includes(record.info.status)
      || record.info.resultNotice && !record.info.resultNotice.handledAt);
    return records.flatMap(record => {
      const info = record.info as SubAgentInfo;
      if(['running','waiting_for_input'].includes(info.status)) {
        // Another live process or unknown host retains ownership; never claim its work.
        if(record.host!==hostname())return [];
        try{process.kill(record.pid,0);return [];}catch(error:any){if(error.code!=='ESRCH')return [];}
        return [{...info,status:'interrupted' as const,recoveryNote:'原执行进程已退出。先检查进度、产物和外部操作结果，再通过原 Role 派遣剩余工作；不得盲目重放整项任务。'}];
      }
      if(info.completedAt && Date.now()-info.completedAt>30*60*1000
        && (!info.resultNotice || info.resultNotice.handledAt) && !hasOpenWork)return [];
      return [info];
    });
  }
  remove(id:string):void {fs.rmSync(this.file(id),{force:true});}
  /** Keep the original execution owner when acknowledging a restored result. */
  acknowledge(parent:string,id:string,noticeId:string):boolean {
    const file=this.file(id);
    if(!fs.existsSync(file))return false;
    const record=JSON.parse(fs.readFileSync(file,'utf8'));
    if(record.parent!==parent || record.info?.id!==id || record.info.resultNotice?.id!==noticeId)return false;
    record.info.resultNotice.handledAt ??= Date.now();
    const tmp=file+'.'+randomUUID()+'.tmp';
    try {fs.writeFileSync(tmp,JSON.stringify(record)+'\n',{mode:0o600});fs.renameSync(tmp,file);}
    finally{fs.rmSync(tmp,{force:true});}
    return true;
  }
  private file(id:string):string {return path.join(this.directory,createHash('sha256').update(id).digest('hex')+'.json');}
}
