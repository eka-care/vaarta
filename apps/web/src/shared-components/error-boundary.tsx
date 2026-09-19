import { Component, ErrorInfo, ReactNode } from 'react';
import { Button } from '@ui/src';
import { RefreshCcw } from 'lucide-react';
import ErrorBoundaryImage from '../../public/assets/error-boundary.svg';
import Image from 'next/image';
import { tracker } from '@/analytics';
import { getAppName } from '@/config/app-branding';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    tracker.error(error, {
      domain: 'crash',
      component: 'ErrorBoundary',
      extra: { componentStack: errorInfo.componentStack },
    });
  }

  handleReload = (): void => {
    window.location.reload();
  };

  render() {
    const { hasError } = this.state;
    const { children, fallback } = this.props;

    if (hasError) {
      if (fallback) {
        return fallback;
      }

      return (
        <div className="h-dvh w-screen bg-background flex justify-center items-center">
          <div className="transform -translate-y-1/4 flex flex-col items-center text-center space-y-3 md:space-y-4 p-4 max-w-3xl">
            <Image src={ErrorBoundaryImage} alt="Error Boundary w-10 h-20" />
            <p className="text-destructive text-sm">{this.state.error?.message}</p>
            <div className="flex flex-col items-center text-center space-y-2">
              <p className="text-lg sm:text-xl md:text-2xl leading-6 md:leading-8 font-semibold">
                There was a problem while loading {getAppName()}
              </p>
              <p className="text-secondary-foreground text-sm">
                Please try reloading the page again to fix the issue.
              </p>
            </div>

            <Button
              onClick={() => {
                this.handleReload();
              }}
              className="cursor-pointer w-fit"
            >
              <RefreshCcw className="w-4 h-4" /> Reload Page
            </Button>
          </div>
        </div>
      );
    }

    return children;
  }
}

export default ErrorBoundary;
