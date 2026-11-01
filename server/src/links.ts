// Bump when the rendered thumbnail size or encoder changes: browsers cache /t/:id
// for a day, and a new query string makes them fetch the sharper image.
export const THUMB_VERSION = '2';

/** Relative links keep the SPA working; absolute ones are for API consumers. */
export function postLinks(id: number, baseUrl: string) {
  return {
    url: `/i/${id}`,
    thumbUrl: `/t/${id}?v=${THUMB_VERSION}`,
    absoluteUrl: `${baseUrl}/i/${id}`,
    absoluteThumbUrl: `${baseUrl}/t/${id}?v=${THUMB_VERSION}`,
  };
}
