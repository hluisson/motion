import {
    useRef,
    isValidElement,
    cloneElement,
    Children,
    ReactElement,
    ReactNode,
    useContext,
} from "react"
import * as React from "react"
import { AnimatePresenceProps } from "./types"
import { useForceUpdate } from "../../utils/use-force-update"
import { useIsMounted } from "../../utils/use-is-mounted"
import { PresenceChild } from "./PresenceChild"
import { LayoutGroupContext } from "../../context/LayoutGroupContext"
import { useIsomorphicLayoutEffect } from "../../utils/use-isomorphic-effect"
import { useUnmountEffect } from "../../utils/use-unmount-effect"
import { invariant } from "../../utils/errors"

type ComponentKey = string | number

const getChildKey = (child: ReactElement<any>): ComponentKey => child.key || ""

function updateChildLookup(
    children: ReactElement<any>[],
    allChildren: Map<ComponentKey, ReactElement<any>>
) {
    children.forEach((child) => {
        const key = getChildKey(child)
        allChildren.set(key, child)
    })
}

function onlyElements(children: ReactNode): ReactElement<any>[] {
    const filtered: ReactElement<any>[] = []

    // We use forEach here instead of map as map mutates the component key by preprending `.$`
    Children.forEach(children, (child) => {
        if (isValidElement(child)) filtered.push(child)
    })

    return filtered
}

/**
 * `AnimatePresence` enables the animation of components that have been removed from the tree.
 *
 * When adding/removing more than a single child, every child **must** be given a unique `key` prop.
 *
 * Any `motion` components that have an `exit` property defined will animate out when removed from
 * the tree.
 *
 * ```jsx
 * import { motion, AnimatePresence } from 'framer-motion'
 *
 * export const Items = ({ items }) => (
 *   <AnimatePresence>
 *     {items.map(item => (
 *       <motion.div
 *         key={item.id}
 *         initial={{ opacity: 0 }}
 *         animate={{ opacity: 1 }}
 *         exit={{ opacity: 0 }}
 *       />
 *     ))}
 *   </AnimatePresence>
 * )
 * ```
 *
 * You can sequence exit animations throughout a tree using variants.
 *
 * If a child contains multiple `motion` components with `exit` props, it will only unmount the child
 * once all `motion` components have finished animating out. Likewise, any components using
 * `usePresence` all need to call `safeToRemove`.
 *
 * @public
 */
export const AnimatePresence: React.FunctionComponent<
    React.PropsWithChildren<AnimatePresenceProps>
> = ({
    children,
    custom,
    initial = true,
    onExitComplete,
    exitBeforeEnter,
    presenceAffectsLayout = true,
    mode = "sync",
}) => {
    invariant(!exitBeforeEnter, "Replace exitBeforeEnter with mode='wait'")

    // We want to force a re-render once all exiting animations have finished. We
    // either use a local forceRender function, or one from a parent context if it exists.
    const forceRender =
        useContext(LayoutGroupContext).forceRender || useForceUpdate()[0]

    const isMounted = useIsMounted()

    // Filter out any children that aren't ReactElements. We can only track ReactElements with a props.key
    const filteredChildren = onlyElements(children)
    let childrenToRender = filteredChildren

    const exitingChildren = useRef(new Map<ComponentKey, ReactElement<any> | undefined>()).current

    // Keep a living record of the children we're actually rendering so we
    // can diff to figure out which are entering and exiting
    const presentChildren = useRef(childrenToRender)

    // A lookup table to quickly reference components by key
    const allChildren = useRef(
        new Map<ComponentKey, ReactElement<any>>()
    ).current

    // If this is the initial component render, just deal with logic surrounding whether
    // we play onMount animations or not.
    const isInitialRender = useRef(true)

    useIsomorphicLayoutEffect(() => {
        isInitialRender.current = false

        updateChildLookup(filteredChildren, allChildren)
        presentChildren.current = childrenToRender
    })

    useUnmountEffect(() => {
        isInitialRender.current = true
        allChildren.clear()
        exitingChildren.clear()
    })

    if (isInitialRender.current) {
        return (
            <>
                {childrenToRender.map((child) => (
                    <PresenceChild
                        key={getChildKey(child)}
                        isPresent
                        initial={initial ? undefined : false}
                        presenceAffectsLayout={presenceAffectsLayout}
                        mode={mode}
                    >
                        {child}
                    </PresenceChild>
                ))}
            </>
        )
    }

    // If this is a subsequent render, deal with entering and exiting children
    childrenToRender = [...childrenToRender]

    // Diff the keys of the currently-present and target children to update our
    // exiting list.
    const presentKeys = presentChildren.current.map(getChildKey)
    const targetKeys = filteredChildren.map(getChildKey)

    // Diff the present children with our target children and mark those that are exiting
    const numPresent = presentKeys.length
    for (let i = 0; i < numPresent; i++) {
        const key = presentKeys[i]

        if (targetKeys.indexOf(key) === -1 && !exitingChildren.has(key)) {
            exitingChildren.set(key, undefined)
        }
    }

    // If we currently have exiting children, and we're deferring rendering incoming children
    // until after all current children have exiting, empty the childrenToRender array
    if (mode === "wait" && exitingChildren.size) {
        childrenToRender = []
    }

    // Loop through all currently exiting components and clone them to overwrite `animate`
    // with any `exit` prop they might have defined.
    exitingChildren.forEach((component, key) => {
        // If this component is actually entering again, early return
        if (targetKeys.indexOf(key) !== -1) return

        const child = allChildren.get(key)
        if (!child) return

        const insertionIndex = presentKeys.indexOf(key)

        let exitingComponent = component
        if (!exitingComponent) { 
            const onExit = () => {
                allChildren.delete(key)
                exitingChildren.delete(key)

                // Remove this child from the present children
                const removeIndex = presentChildren.current.findIndex(
                    (presentChild) => presentChild.key === key
                )
                presentChildren.current.splice(removeIndex, 1)

                // Defer re-rendering until all exiting children have indeed left
                if (!exitingChildren.size) {
                    presentChildren.current = filteredChildren

                    if (isMounted.current === false) return

                    forceRender()
                    onExitComplete && onExitComplete()
                }
            }
            
            exitingComponent = (
                <PresenceChild
                    key={getChildKey(child)}
                    isPresent={false}
                    onExitComplete={onExit}
                    custom={custom}
                    presenceAffectsLayout={presenceAffectsLayout}
                    mode={mode}
                >
                    {child}
                </PresenceChild>
            )
            exitingChildren.set(key, exitingComponent)

        }

        childrenToRender.splice(
            insertionIndex,
            0,
            exitingComponent
        )
    })

    // Add `MotionContext` even to children that don't need it to ensure we're rendering
    // the same tree between renders
    childrenToRender = childrenToRender.map((child) => {
        const key = child.key as string | number
        return exitingChildren.has(key) ? (
            child
        ) : (
            <PresenceChild
                key={getChildKey(child)}
                isPresent
                presenceAffectsLayout={presenceAffectsLayout}
                mode={mode}
            >
                {child}
            </PresenceChild>
        )
    })

    if (
        process.env.NODE_ENV !== "production" &&
        mode === "wait" &&
        childrenToRender.length > 1
    ) {
        console.warn(
            `You're attempting to animate multiple children within AnimatePresence, but its mode is set to "wait". This will lead to odd visual behaviour.`
        )
    }

    return (
        <>
            {exitingChildren.size
                ? childrenToRender
                : childrenToRender.map((child) => cloneElement(child))}
        </>
    )
}
