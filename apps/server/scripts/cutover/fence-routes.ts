import { api } from "./cloudflare"
export interface AuthoritySurface { origins: string[]; workersDev: boolean; previews: boolean }
/** Every public way into one Worker, from the account control plane, never from an export request. */
export const authoritySurface = async (worker: string): Promise<AuthoritySurface> => {
 if(!/^[a-z0-9-]+$/.test(worker))throw Error('CF_FENCE_WORKER_INVALID')
 const domains=(await api<Array<{hostname:string;service:string;environment:string;enabled:boolean}>>('/workers/domains')).result
 const custom=domains.filter(d=>d.service===worker&&d.environment==='production'&&d.enabled).map(d=>'https://'+d.hostname)
 // Zone routes (e.g. smithers.sh/*) are a separate surface from custom domains.
 for(const route of (await api<Array<{pattern:string;script?:string}>>('/workers/scripts/'+worker+'/routes')).result){
  const match=/^([a-z0-9.-]+)\/\*$/.exec(route.pattern)
  // A wildcard host or partial path cannot be probed exhaustively; refuse rather than skip it.
  if(!match||route.script!==worker)throw Error('CF_FENCE_ROUTE_UNPROBEABLE')
  custom.push('https://'+match[1])
 }
 const settings=(await api<{enabled:boolean;previews_enabled:boolean}>('/workers/scripts/'+worker+'/subdomain')).result
 if(settings.enabled){const account=(await api<{subdomain:string}>('/workers/subdomain')).result;if(!/^[a-z0-9-]+$/.test(account.subdomain))throw Error('CF_FENCE_ACCOUNT_SUBDOMAIN_INVALID');custom.push(`https://${worker}.${account.subdomain}.workers.dev`)}
 if(!custom.length)throw Error('CF_FENCE_ORIGIN_UNOBSERVABLE')
 if(custom.some(origin=>{const u=new URL(origin);return u.origin!==origin||u.protocol!=='https:'||u.username||u.password}))throw Error('CF_FENCE_DOMAIN_INVALID')
 return {origins:[...new Set(custom)].sort(),workersDev:settings.enabled===true,previews:settings.previews_enabled===true}
}
/** Origins for a fenced authority. */
export const authorityOrigins = async (worker:string):Promise<string[]>=>{
 const surface=await authoritySurface(worker)
 // Version-preview URLs bypass the deployment being proved; no cutover may
 // treat those as harmless alternate routes to a fenced deployment.
 if(surface.previews)throw Error('CF_FENCE_VERSION_PREVIEWS_ENABLED')
 return surface.origins
}
