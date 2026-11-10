'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { LoadingState } from '@/components/ui';
import { useMe } from '@/lib/providers';

export default function Index() {
  const router = useRouter();
  const me = useMe();
  useEffect(() => {
    if (me.isSuccess) router.replace('/home');
    if (me.isError) router.replace('/login');
  }, [me.isSuccess, me.isError, router]);
  return <LoadingState card />;
}
