import type {Metadata} from 'next';
import {DM_Sans, DM_Mono} from 'next/font/google';
import {Toaster} from 'sonner';
import {Nav} from '@/components/Nav';
import './globals.css';

// next/font must be loaded in a server component. Exposed as CSS variables that
// globals.css / tailwind map to `--font-ui` / `--font-mono` (spec §10.3).
const dmSans = DM_Sans({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  variable: '--font-ui',
  display: 'swap',
});

const dmMono = DM_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Faceless Video Studio',
  description: 'Scrub the generated video and render it locally.',
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en" className={`${dmSans.variable} ${dmMono.variable}`}>
      <body>
        <Nav />
        {children}
        <Toaster theme="dark" position="bottom-right" />
      </body>
    </html>
  );
}
