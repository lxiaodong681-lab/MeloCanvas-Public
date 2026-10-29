import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import type {
	FlatList,
	LayoutChangeEvent,
	NativeScrollEvent,
	NativeSyntheticEvent,
	ViewToken,
} from 'react-native'

import type { PlaylistItem } from './core/playlists'
import type { PlaylistSession } from './playlist-session'

type Row = { item: PlaylistItem; index: number }
type Position = ReturnType<PlaylistSession['getDetailScroll']>
interface Restore {
	active: boolean
	identity: object
	position: Position
	target: Position
	restoring: boolean
	frame: number | null
	commanded: number | null
}

/** Owns only this list's viewport. Late native callbacks cannot overwrite a newer view. */
export function usePlaylistScroll(
	session: PlaylistSession,
	token: number,
	rows: readonly Row[],
) {
	const ref = useRef<FlatList<Row>>(null)
	const dimensions = useRef({ viewport: 0, content: 0, header: 0 })
	const ownerRef = useRef<Restore | null>(null)
	const identity = useMemo(() => ({ session, token }), [session, token])
	const currentOwner = useCallback(() => {
		const owner = ownerRef.current
		return owner?.active &&
			owner.identity === identity &&
			session.getSnapshot().detailViewToken === token
			? owner
			: null
	}, [identity, session, token])
	const remember = useCallback(() => {
		const owner = currentOwner()
		if (owner && !owner.restoring)
			session.recordDetailScroll(token, owner.position)
	}, [currentOwner, session, token])
	const restore = useCallback(() => {
		const owner = currentOwner()
		if (
			!owner ||
			!owner.restoring ||
			!dimensions.current.viewport ||
			!dimensions.current.content
		)
			return
		if (owner.frame !== null) cancelAnimationFrame(owner.frame)
		owner.frame = requestAnimationFrame(() => {
			owner.frame = null
			if (currentOwner() !== owner || !owner.restoring) return
			owner.target = session.getDetailScroll(token)
			if (owner.target.itemId && owner.target.index > 0) {
				// Rows vary with theme/font/pending state. Do not invent fixed geometry.
				ref.current?.scrollToIndex({
					index: owner.target.index,
					animated: false,
				})
			} else {
				owner.commanded = Math.min(
					owner.target.offset,
					Math.max(0, dimensions.current.content - dimensions.current.viewport),
				)
				ref.current?.scrollToOffset({
					offset: owner.commanded,
					animated: false,
				})
				// A zero-distance native command need not emit onScroll.
				if (owner.commanded === 0) {
					owner.restoring = false
					owner.position = { itemId: null, index: 0, offset: 0 }
					remember()
				}
			}
		})
	}, [currentOwner, session, token, remember])
	useLayoutEffect(() => {
		const saved = session.getDetailScroll(token)
		const owner: Restore = {
			active: true,
			identity,
			position: saved,
			target: saved,
			restoring: true,
			frame: null,
			commanded: null,
		}
		ownerRef.current = owner
		restore()
		return () => {
			owner.active = false
			if (owner.frame !== null) cancelAnimationFrame(owner.frame)
		}
	}, [identity, restore, session, token])
	const onScroll = useCallback(
		(event: NativeSyntheticEvent<NativeScrollEvent>) => {
			const owner = currentOwner()
			if (!owner) return
			owner.position = {
				...owner.position,
				offset: Math.max(0, event.nativeEvent.contentOffset.y),
			}
			if (owner.position.offset === 0 && !owner.restoring)
				owner.position = { itemId: null, index: 0, offset: 0 }
			if (
				owner.restoring &&
				!owner.target.index &&
				owner.commanded !== null &&
				Math.abs(owner.position.offset - owner.commanded) <= 1
			)
				owner.restoring = false
			remember()
		},
		[currentOwner, remember],
	)
	const onViewableItemsChanged = useCallback(
		({ viewableItems }: { viewableItems: ViewToken<Row>[] }) => {
			const owner = currentOwner()
			if (!owner) return
			const first = viewableItems.find(
				(item) => item.isViewable && item.index !== null,
			)
			if (first && (owner.position.offset > 0 || first.index! > 0))
				owner.position = {
					...owner.position,
					itemId: first.item.item.itemId,
					index: first.index!,
				}
			if (owner.restoring) owner.target = session.getDetailScroll(token)
			if (owner.restoring && owner.target.itemId) {
				if (
					viewableItems.some(
						(item) =>
							item.isViewable && item.item.item.itemId === owner.target.itemId,
					)
				) {
					owner.restoring = false
					if (owner.frame !== null) cancelAnimationFrame(owner.frame)
					owner.frame = null
				} else restore()
			}
			remember()
		},
		[currentOwner, remember, restore, session, token],
	)
	return {
		onHeaderLayout: (event: LayoutChangeEvent) => {
			if (!currentOwner()) return
			const height = event.nativeEvent.layout.height
			if (Number.isFinite(height) && height >= 0)
				dimensions.current.header = height
			restore()
		},
		ref,
		onLayout: (event: LayoutChangeEvent) => {
			if (!currentOwner()) return
			dimensions.current.viewport = event.nativeEvent.layout.height
			restore()
		},
		onContentSizeChange: (_width: number, height: number) => {
			if (!currentOwner()) return
			dimensions.current.content = height
			restore()
		},
		onScroll,
		onScrollBeginDrag: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
			const owner = currentOwner()
			if (!owner) return
			owner.restoring = false
			if (owner.frame !== null) cancelAnimationFrame(owner.frame)
			owner.frame = null
			onScroll(event)
		},
		onScrollEndDrag: onScroll,
		onMomentumScrollEnd: onScroll,
		onViewableItemsChanged,
		onScrollToIndexFailed: ({
			index,
			averageItemLength,
		}: {
			index: number
			averageItemLength: number
		}) => {
			const owner = currentOwner()
			if (!owner || !owner.restoring || !rows.length) return
			owner.target = session.getDetailScroll(token)
			if (index !== owner.target.index || !owner.target.itemId) {
				restore()
				return
			}
			// Ask FlatList to measure the target neighborhood, then retry on its
			// content/viewability event. User scrolling cancels restoration immediately.
			ref.current?.scrollToOffset({
				offset: Math.max(
					0,
					dimensions.current.header
						? dimensions.current.header + averageItemLength * index
						: owner.target.offset || averageItemLength * index,
				),
				animated: false,
			})
		},
		scrollEventThrottle: 100,
	}
}
