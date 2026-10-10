// A unique lease per activation prevents a late native promise from releasing a newer lock.
export function keepSessionAwake(activate: (tag: string) => Promise<void>, deactivate: (tag: string) => Promise<void>, tag: string) {
 let disposed = false;
 void activate(tag).then(() => { if (disposed) void deactivate(tag).catch(() => {}); }).catch(() => {});
 return () => { disposed = true; void deactivate(tag).catch(() => {}); };
}
