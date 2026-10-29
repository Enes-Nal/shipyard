import { RootProvider } from 'fumadocs-ui/provider/next';
import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import SearchDialog from '@/components/search';
import { siteUrl } from '@/lib/shared';
import './global.css';

// The landing page's own faces (site/assets/fonts), self-hosted.
const inter = localFont({
  src: '../../site/assets/fonts/inter-latin-wght.woff2',
  weight: '100 900',
  variable: '--font-inter',
  display: 'swap',
});

const mono = localFont({
  src: '../../site/assets/fonts/jetbrains-mono-latin-wght.woff2',
  weight: '100 800',
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: 'Terminal docs', template: '%s · Terminal docs' },
  description: 'Documentation for Terminal: run coding agents on your own dev boxes, and work with them as if they were on your laptop.',
  openGraph: { siteName: 'Terminal docs', type: 'website' },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#18191c' },
  ],
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider search={{ SearchDialog }} theme={{ defaultTheme: 'system', enableSystem: true }}>
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
