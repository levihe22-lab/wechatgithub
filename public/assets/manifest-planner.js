import{HEADER_SIZE,MAX_FRAME_LENGTH,hexToBytes}from'./wcv3-header.js';
const TYPES=new Set(['contacts','avatar','message-page','dates','search-shard','image','video','voice','path-records']);
export class ManifestPlanner{
 constructor(manifest,fileSize,manifestRange){
  if(!manifest||manifest.format!=='WCV3'||manifest.version!==3||!Array.isArray(manifest.resources)||manifest.resources.length>100000)throw new Error('E_FORMAT');
  this.resources=new Map();const ranges=[manifestRange];
  for(const item of manifest.resources){if(!item||!TYPES.has(item.type)||typeof item.contentType!=='string'||!Number.isSafeInteger(item.offset)||!Number.isSafeInteger(item.length)||item.offset<HEADER_SIZE||item.length<32||item.length>MAX_FRAME_LENGTH||item.offset+item.length>fileSize)throw new Error('E_FORMAT');const idBytes=hexToBytes(item.id);if(this.resources.has(idBytes))throw new Error('E_FORMAT');ranges.push({offset:item.offset,length:item.length});this.resources.set(idBytes,Object.freeze({...item}));}
  ranges.sort((a,b)=>a.offset-b.offset);for(let i=1;i<ranges.length;i++)if(ranges[i].offset<ranges[i-1].offset+ranges[i-1].length)throw new Error('E_FORMAT');
  this.conversations=Array.isArray(manifest.conversations)?manifest.conversations:[];const shards=manifest.searchShards;this.searchShards=(Array.isArray(shards)||(shards&&typeof shards==='object'))?shards:[];
 }
 resource(id){const value=this.resources.get(typeof id==='string'?hexToBytes(id):id);if(!value)throw new Error('E_FORMAT');return value;}
 page(conversationId,pageIndex){const c=this.conversations.find(v=>v.id===conversationId);if(!c||!Array.isArray(c.pages)||!Number.isInteger(pageIndex)||pageIndex<0||pageIndex>=c.pages.length)throw new Error('E_FORMAT');return this.resource(c.pages[pageIndex]);}
 searchPlan(scope='all'){if(!this.searchShards){return[]}const ids=Array.isArray(this.searchShards)?this.searchShards.filter(v=>v&&typeof v.resourceId==='string'&&(v.scope===scope||v.scope==='all')).map(v=>v.resourceId):Object.values(this.searchShards).filter(id=>typeof id==='string');return[...new Set(ids)].map(id=>this.resource(id));}
 list(type){return[...this.resources.values()].filter(v=>!type||v.type===type);}
}
