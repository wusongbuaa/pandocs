/**
 * A page's title is its only `h1`, so `#` in the body must not render as more page titles: sections step down a level.
 * A first heading that repeats the title is that title, and stays.
 */
export function headingsStepDown(depths: readonly number[], firstRepeatsTitle: boolean): boolean {
  return (firstRepeatsTitle ? depths.slice(1) : depths).includes(1);
}
