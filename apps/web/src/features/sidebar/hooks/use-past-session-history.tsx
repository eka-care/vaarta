'use client';

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { with401Retry } from '@/fetch-client/api-with-retry';
import { TPastSessionHistory } from '@/constants/types';
import { getSDK } from '@/features/session/services/sdk-provider';
import useVoice2RxStore from '@/store/store';

interface UseOptimizedPastSessionsOptions {
  initialBatchSize?: number;
  loadMoreBatchSize?: number;
  pageSize?: number;
}

export const usePastSessionsHistory = ({
  initialBatchSize = 10,
  loadMoreBatchSize = 10,
  pageSize = 10,
}: UseOptimizedPastSessionsOptions = {}) => {
  const [allSessions, setAllSessions] = useState<TPastSessionHistory>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [isInitialized, setIsInitialized] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const { setRefreshPastSessionsCallback } = useVoice2RxStore();
  const sessionV2ContentById = useVoice2RxStore((s) => s.sessionV2ContentById);

  // Search state
  const isSearching = searchQuery.trim().length > 0;

  // Filter sessions by title when searching. Same fallback as the list row:
  // the store first (fresh renames), then the title the /history response
  // already carries — otherwise search only ever matched sessions that had
  // been opened this visit.
  const filteredSessions = useMemo(() => {
    if (!isSearching) return [];

    const query = searchQuery.toLowerCase().trim();
    return allSessions.filter((session) => {
      const title = (
        (sessionV2ContentById[session.txn_id]?.session_details?.title as string | undefined) ||
        session.session_details?.title ||
        ''
      ).toLowerCase();
      return title.includes(query);
    });
  }, [allSessions, searchQuery, isSearching, sessionV2ContentById]);

  const totalFetchedRef = useRef(0);

  // Pagination computed values
  const totalPages = useMemo(
    () => Math.ceil(allSessions.length / pageSize),
    [allSessions, pageSize]
  );

  const paginatedSessions = useMemo(() => {
    return allSessions.slice(0, (currentPage + 1) * pageSize);
  }, [allSessions, currentPage, pageSize]);

  const hasPrevPage = currentPage > 0;
  const hasNextPage = currentPage < totalPages - 1 || hasMore;

  // Pagination info for display
  const paginationInfo = useMemo(() => {
    const startNum = allSessions.length === 0 ? 0 : currentPage * pageSize + 1;
    const endNum = Math.min((currentPage + 1) * pageSize, allSessions.length);
    const totalNum = allSessions.length;
    return { startNum, endNum, totalNum };
  }, [allSessions.length, currentPage, pageSize]);

  const fetchSessionsFromAPI = useCallback(async (count: number = 10) => {
    try {
      setError(null);

      const response = await with401Retry(
        () =>
          getSDK().sessions.getSessionHistory({
            txn_count: count,
          }),
        'get session history'
      );

      const { status_code: statusCode, data: sessionData } = response;

      if (statusCode === 403) {
        setError('Authentication required. Please login again.');
        return;
      }

      if (statusCode === 200 && sessionData && sessionData.length > 0) {
        setAllSessions(sessionData);
        totalFetchedRef.current = sessionData.length;
        // Check if we have more data available
        setHasMore(sessionData.length >= count);
        return sessionData;
      } else {
        setAllSessions([]);
      }
    } catch (err) {
      console.error('Error fetching session summary:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch session history');
      setAllSessions([]);
      setHasMore(false);
      return [];
    }
  }, []);

  const goToNextPage = useCallback(async () => {
    if (currentPage < totalPages - 1) {
      setCurrentPage((prev) => prev + 1);
    } else if (hasMore) {
      // Need to fetch more sessions
      setLoadingMore(true);
      const newTotalCount = totalFetchedRef.current + loadMoreBatchSize;
      const sessions = await fetchSessionsFromAPI(newTotalCount);
      if (sessions && sessions.length > allSessions.length) {
        setCurrentPage((prev) => prev + 1);
      }
      setLoadingMore(false);
    }
  }, [
    currentPage,
    totalPages,
    hasMore,
    loadMoreBatchSize,
    allSessions.length,
    fetchSessionsFromAPI,
  ]);

  const goToPrevPage = useCallback(() => {
    if (currentPage > 0) {
      setCurrentPage((prev) => prev - 1);
    }
  }, [currentPage]);

  // Load initial sessions
  const loadInitialSessions = useCallback(async () => {
    if (isInitialized) return;

    setLoading(true);
    setIsInitialized(true);

    await fetchSessionsFromAPI(initialBatchSize);

    setLoading(false);
  }, [fetchSessionsFromAPI, initialBatchSize, isInitialized]);

  // Refresh sessions (reset and fetch fresh data)
  const refreshSessions = useCallback(async () => {
    setLoading(true);
    setAllSessions([]);
    setError(null);
    setHasMore(true);
    setCurrentPage(0);
    totalFetchedRef.current = 0;

    await fetchSessionsFromAPI(initialBatchSize);

    setLoading(false);
  }, [fetchSessionsFromAPI, initialBatchSize]);

  // Initialize on mount
  useEffect(() => {
    loadInitialSessions();

    setRefreshPastSessionsCallback(refreshSessions);

    return () => {
      setRefreshPastSessionsCallback(null);
    };
  }, [loadInitialSessions]);

  // Clear search when refreshing
  const handleRefreshSessions = useCallback(async () => {
    setSearchQuery('');
    await refreshSessions();
  }, [refreshSessions]);

  const removeSession = useCallback(
    (txnId: string) => {
      setAllSessions((prev) => {
        const updated = prev.filter((s) => s.txn_id !== txnId);
        // If current page is now beyond total pages, go back one
        const newTotalPages = Math.ceil(updated.length / pageSize);
        setCurrentPage((p) => (p >= newTotalPages && p > 0 ? p - 1 : p));
        return updated;
      });
    },
    [pageSize]
  );

  return {
    // When searching, return filtered results; otherwise return paginated
    sessions: isSearching ? filteredSessions : paginatedSessions,
    allSessions,
    loading,
    loadingMore,
    error,
    hasMore,
    // Pagination (disabled when searching)
    currentPage,
    totalPages,
    hasPrevPage: isSearching ? false : hasPrevPage,
    hasNextPage: isSearching ? false : hasNextPage,
    goToNextPage,
    goToPrevPage,
    paginationInfo,
    refreshSessions: handleRefreshSessions,
    removeSession,
    // Search
    searchQuery,
    setSearchQuery,
    isSearching,
    filteredSessions,
    searchResultsCount: filteredSessions.length,
  };
};
