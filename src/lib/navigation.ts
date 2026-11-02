export const PAGE_IDS = ['tickets','inbox','projects','activity','agents','skills','instructions','settings','trash'] as const;
export type PageId = typeof PAGE_IDS[number];
export interface NavigationPreferences { order: PageId[]; hidden: PageId[] }
export const defaultNavigation: NavigationPreferences = {order:[...PAGE_IDS],hidden:[]};
export function normalizeNavigation(value: NavigationPreferences): NavigationPreferences {
  const valid = (id: string): id is PageId => (PAGE_IDS as readonly string[]).includes(id);
  return {order:[...new Set([...(Array.isArray(value?.order) ? value.order.filter(valid) : []),...PAGE_IDS])],hidden:[...new Set(Array.isArray(value?.hidden) ? value.hidden.filter(valid) : [])]};
}
export function movePage(order:PageId[],id:PageId,target:PageId) {
  if (!order.includes(id) || !order.includes(target)) return order;
  const next=order.filter(p=>p!==id);next.splice(order.indexOf(target),0,id);return next;
}

export function openingPage(value:unknown):PageId {
  return typeof value === 'string' && (PAGE_IDS as readonly string[]).includes(value) ? value as PageId : 'tickets';
}
export function startupHash(hash:string,value:unknown):string {
  return hash && hash !== '#' && hash !== '#/' ? hash : `#/${openingPage(value)}`;
}
