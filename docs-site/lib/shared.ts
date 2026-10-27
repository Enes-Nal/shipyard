export const appName = 'Terminal';
export const siteUrl = 'https://docs.berthd.app';
export const landingUrl = 'https://berthd.app';

export const gitConfig = {
  user: 'cosscom',
  repo: 'shipyard',
  branch: 'main',
};

export const githubUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;

// The content lives in the repository's own docs/ folder; a page's path is
// relative to it.
export function editUrl(path: string) {
  return `${githubUrl}/blob/${gitConfig.branch}/docs/${path}`;
}
