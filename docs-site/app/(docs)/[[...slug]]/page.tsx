import { source } from '@/lib/source';
import { DocsBody, DocsDescription, DocsPage, DocsTitle, EditOnGitHub } from 'fumadocs-ui/layouts/docs/page';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import { getMDXComponents } from '@/components/mdx';
import { editUrl, githubUrl, landingUrl } from '@/lib/shared';
import { sectionTitle } from '@/lib/sections';

export default async function Page(props: PageProps<'/[[...slug]]'>) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const home = page.slugs.length === 0;
  // The small label above the title: the page's section, or on the home
  // page what the whole site is. Sentence case, like the landing page's.
  const eyebrow = home ? 'Documentation' : sectionTitle(page.slugs);

  return (
    <DocsPage toc={page.data.toc} full={page.data.full} footer={{ children: <PageFoot /> }}>
      <header className="berth-page-head" data-home={home || undefined} data-section={page.slugs[0]}>
        {eyebrow && <p className="berth-eyebrow">{eyebrow}</p>}
        <DocsTitle>{home ? 'Terminal documentation' : page.data.title}</DocsTitle>
        <DocsDescription>{page.data.description}</DocsDescription>
      </header>
      <DocsBody>
        <MDX components={getMDXComponents({ a: createRelativeLink(source, page) })} />
      </DocsBody>
      <div className="berth-edit-row">
        <EditOnGitHub href={editUrl(page.path)} className="berth-edit">
          Edit this page on GitHub
        </EditOnGitHub>
      </div>
    </DocsPage>
  );
}

// The end of every page, after prev and next: where Terminal lives.
function PageFoot() {
  return (
    <footer className="berth-foot">
      <span>Terminal is open source.</span>
      <nav aria-label="Elsewhere">
        <a href={landingUrl}>berthd.app</a>
        <a href={githubUrl}>GitHub</a>
        <a href={`${githubUrl}/issues`}>Report an issue</a>
      </nav>
    </footer>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

// A page's link preview, drawn by app/og/[...slug]/route.tsx.
const ogImage = (slugs: string[]) => ({ url: `/og/${[...slugs, 'image.png'].join('/')}`, width: 1200, height: 630 });

export async function generateMetadata(props: PageProps<'/[[...slug]]'>): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();
  return {
    title: page.data.title,
    description: page.data.description,
    alternates: { canonical: page.url },
    openGraph: { title: page.data.title, description: page.data.description, url: page.url, images: [ogImage(page.slugs)] },
    twitter: { card: 'summary_large_image', images: [ogImage(page.slugs)] },
  };
}
