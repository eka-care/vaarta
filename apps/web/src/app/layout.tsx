import { Suspense } from 'react';
import type { Metadata } from 'next';
// Self-hosted fonts (on-prem: no Google Fonts fetch at build time)
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import './globals.css';
import { ThemeProvider } from '@ui/src';
import ScreenContainer from '@/shared-components/screen-container';
import ProtectedRouteProvider from '@/provider/protected-route-provider';
import { ToastWrapper } from '@/shared-components/toast-wrapper';
import ErrorBoundaryProvider from '@/provider/error-boundary-provider';
import QueryClientRootProvider from '@/provider/query-client-provider';
import SecretsProvider from '@/provider/secrets-provider';
import Script from 'next/script';
import OfflineIndicator from '@/shared-components/offline-indicator';
import { PlatformProvider } from '@/platform';
import DesktopAuthBootstrap from '@/provider/desktop-auth-bootstrap';
import AppBrandingLoader from '@/shared-components/app-branding-loader';

const geistSans = { variable: GeistSans.variable };
const geistMono = { variable: GeistMono.variable };

// Build-time default; AppBrandingLoader replaces the title at runtime with
// the deployment's APP_NAME.
export const metadata: Metadata = {
  title: 'Vaarta',
  description: 'AI-powered voice transcription and note taking',
  other: {
    'apple-itunes-app': 'app-id=6756741683',
  },
};

// root layout which will wrap all the pages inside app.tsx, u can create specific layout for each page
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        {/* Google Tag Manager — opt-in for on-prem (NEXT_PUBLIC_ENABLE_GTM + id) */}
        {process.env.NEXT_PUBLIC_ENABLE_GTM === 'true' && process.env.NEXT_PUBLIC_GTM_ID && (
          <Script
            id="gtm-script"
            strategy="beforeInteractive"
            dangerouslySetInnerHTML={{
              __html: `
                (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
                new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
                j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
                'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
                })(window,document,'script','dataLayer','${process.env.NEXT_PUBLIC_GTM_ID}');
              `,
            }}
          />
        )}
      </head>

      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        {/* Google Tag Manager (noscript) */}
        {process.env.NEXT_PUBLIC_ENABLE_GTM === 'true' && process.env.NEXT_PUBLIC_GTM_ID && (
          <noscript>
            <iframe
              src={`https://www.googletagmanager.com/ns.html?id=${process.env.NEXT_PUBLIC_GTM_ID}`}
              height="0"
              width="0"
              style={{ display: 'none', visibility: 'hidden' }}
            />
          </noscript>
        )}

        <ErrorBoundaryProvider>
          <SecretsProvider>
            <QueryClientRootProvider>
              <ThemeProvider defaultTheme="doctor-light">
                <PlatformProvider>
                  <DesktopAuthBootstrap>
                    <Suspense>
                      <ScreenContainer>
                        <ProtectedRouteProvider>{children}</ProtectedRouteProvider>
                      </ScreenContainer>
                    </Suspense>
                  </DesktopAuthBootstrap>
                  <AppBrandingLoader />
                  <ToastWrapper />
                  <OfflineIndicator />
                </PlatformProvider>
              </ThemeProvider>
            </QueryClientRootProvider>
          </SecretsProvider>
        </ErrorBoundaryProvider>
      </body>
    </html>
  );
}
