// Find bar for the file in the panel. Matches are Ranges over the shown document, so
// nothing in it is rewritten and a refetched file is searched again rather than left half-marked.

import { useEffect, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { FindBar } from '../FindBar';
import { clearMatches, findRanges, paintMatches, scrollToRange } from '../../utils/find-matches';

export interface FindTarget {
    /** Where the text to search lives */
    root: Node;
    /** What scrolls it */
    scroller: Element;
}

interface FileViewerFindProps {
    getTarget: () => FindTarget | null;
    /** Changes when the shown document does, so matches in the old one are searched for again */
    contentKey: unknown;
    onClose: () => void;
    inputRef: RefObject<HTMLInputElement | null>;
}

interface Found {
    target: FindTarget;
    ranges: Range[];
}

export function FileViewerFind({ getTarget, contentKey, onClose, inputRef }: FileViewerFindProps) {
    const { t } = useTranslation();
    const [query, setQuery] = useState('');
    const [found, setFound] = useState<Found | null>(null);
    const [index, setIndex] = useState(0);
    const total = found?.ranges.length ?? 0;

    useEffect(() => {
        const timer = setTimeout(() => {
            const target = query ? getTarget() : null;
            setFound(target && { target, ranges: findRanges(target.root, query) });
            setIndex(0);
        }, 150);
        return () => clearTimeout(timer);
    }, [query, contentKey, getTarget]);

    useEffect(() => {
        if (!found) return;
        const active = found.ranges[index];
        paintMatches(found.target.root, found.ranges, active);
        if (active) scrollToRange(active, found.target.scroller);
        return () => clearMatches(found.target.root);
    }, [found, index]);

    return (
        <FindBar
            query={query}
            onQueryChange={setQuery}
            placeholder={t('fileViewer.findPlaceholder')}
            current={index}
            total={total}
            onNext={() => total && setIndex(i => (i + 1) % total)}
            onPrevious={() => total && setIndex(i => (i + total - 1) % total)}
            onClose={onClose}
            inputRef={inputRef}
        />
    );
}
