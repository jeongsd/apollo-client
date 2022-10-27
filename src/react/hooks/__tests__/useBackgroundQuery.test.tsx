import * as React from "react";
import { render, waitFor } from "@testing-library/react";
import { act } from "react-dom/test-utils";
import { Subscription } from "zen-observable-ts";

import { useFragment_experimental } from "../useFragment";
import { useBackgroundQuery_experimental } from "../useBackgroundQuery";
import { itAsync, MockedProvider } from "../../../testing";
import { ApolloProvider } from "../../context";
import {
  ApolloClient,
  ApolloLink,
  ApolloQueryResult,
  gql,
  TypedDocumentNode,
  InMemoryCache,
  // Reference,
  Observable,
  NetworkStatus,
} from "../../../core";

describe("useBackgroundQuery", () => {
  itAsync("can be used as a replacement for useQuery", (resolve, reject) => {
    type TData = {
      words: string[];
    };

    const query: TypedDocumentNode<TData> = gql`
      query WordsQuery {
        words
      }
    `;

    let sub: Subscription | undefined;
    const subResults = new Map<number, ApolloQueryResult<TData>>();

    let renderCount = 0;
    function Component() {
      const { observable, useData } = useBackgroundQuery_experimental({
        query,
      });

      const data = useData();

      try {
        switch (++renderCount) {
          case 1:
            expect(data).toBeUndefined();
            break;
          case 2:
            expect(data).toEqual({
              words: ["oyez"],
            });
            observable.refetch();
            break;
          case 3:
            expect(data).toEqual({
              words: ["oyez"],
            });
            break;
          case 4:
            expect(data).toEqual({
              words: ["oyez", "noyez"],
            });
            break;
          default:
            throw new Error(`too many renders (${renderCount})`);
        }
      } catch (error) {
        reject(error);
      }

      if (!sub) {
        sub = observable.subscribe({
          error: reject,
          next(result) {
            subResults.set(renderCount, result);
          },
        });
      }

      return null;
    }

    render(
      <MockedProvider
        mocks={[
          {
            request: { query },
            result: {
              data: {
                words: ["oyez"],
              },
            },
          },
          {
            request: { query },
            result: {
              data: {
                words: ["oyez", "noyez"],
              },
            },
          },
        ]}
      >
        <Component />
      </MockedProvider>
    );

    waitFor(() => {
      expect(renderCount).toBe(4);
      expect(subResults.size).toBe(3);
    })
      .then(() => {
        sub?.unsubscribe();

        expect(subResults.get(1)).toEqual({
          loading: false,
          networkStatus: NetworkStatus.ready,
          data: { words: ["oyez"] },
        });

        expect(subResults.get(2)).toEqual({
          loading: true,
          networkStatus: NetworkStatus.refetch,
          data: { words: ["oyez"] },
        });

        expect(subResults.get(3)).toEqual({
          loading: false,
          networkStatus: NetworkStatus.ready,
          data: { words: ["oyez", "noyez"] },
        });
      })
      .then(resolve, reject);
  });

  type Item = {
    __typename: string;
    id: number;
    text?: string;
    foo?: string;
    bar?: string;
  };

  const ListFragment: TypedDocumentNode<QueryData> = gql`
    fragment ListFragment on Query {
      list {
        id
      }
    }
  `;

  const ItemFragment: TypedDocumentNode<Item> = gql`
    fragment ItemFragment on Item @nonreactive {
      text
      foo
    }
  `;

  type QueryData = {
    list: Item[];
  };

  itAsync.only(
    "useBackgroundQuery avoids depending on whole query response",
    async (resolve, reject) => {
      const cache = new InMemoryCache({
        typePolicies: {
          Item: {
            fields: {
              text(existing, { readField }) {
                return existing || `Item #${readField("id")}`;
              },
              foo(existing, { readField }) {
                return existing || `Foo #${readField("id")}`;
              },
              bar(existing, { readField }) {
                return existing || `Bar #${readField("id")}`;
              },
            },
          },
        },
      });

      const client = new ApolloClient({
        cache,
        link: new ApolloLink(
          (operation) =>
            new Observable((observer) => {
              if (operation.operationName === "ListQueryWithItemFragment") {
                setTimeout(() => {
                  observer.next({
                    data: {
                      list: [
                        { __typename: "Item", id: 1 },
                        { __typename: "Item", id: 2 },
                        { __typename: "Item", id: 5 },
                      ],
                    },
                  });
                  observer.complete();
                }, 10);
              } else {
                observer.error(
                  `unexpected query ${
                    operation.operationName || operation.query
                  }`
                );
              }
            })
        ),
      });

      const listQuery: TypedDocumentNode<QueryData> = gql`
        query ListQueryWithItemFragment {
          list {
            id
            # The inclusion of this fragment is the key difference between this
            # test and the previous one.
            # foo @nonreactive
            ...ItemFragment
            # ... on Item @nonreactive {
            #   bar
            #   id
            # }
          }
        }
        # fragment ItemFragment on Item @nonreactive {
        #   text
        #   foo
        # }
        # ${ItemFragment}
      `;

      const renders: string[] = [];

      function List() {
        renders.push("list");

        const { observable, useData } = useBackgroundQuery_experimental({
          query: listQuery,
        });

        const { complete, data } = useFragment_experimental({
          fragment: ListFragment,
          from: { __typename: "Query" },
        });

        expect(observable.getLastError()).toBeUndefined();

        // We avoid actually calling these hooks in this test because their state
        // transitions would result in additional renders of the List component.
        expect(typeof useData).toBe("function");

        return complete ? (
          <ol>
            {data!.list.map((item) => (
              <Item key={item.id} id={item.id} />
            ))}
          </ol>
        ) : null;
      }

      function Item(props: { id: number }) {
        renders.push("item " + props.id);
        const { complete, data } = useFragment_experimental({
          fragment: ItemFragment,
          from: {
            __typename: "Item",
            id: props.id,
          },
        });
        return <li>{complete ? data!.text : "incomplete"}</li>;
      }

      // why do we need to memoize in React 17?
      // const MemoizedItem = React.memo(Item);

      const { getAllByText } = render(
        <ApolloProvider client={client}>
          <List />
        </ApolloProvider>
      );

      function getItemTexts() {
        return getAllByText(/^Item/).map((li) => li.firstChild!.textContent);
      }

      await waitFor(() => {
        expect(getItemTexts()).toEqual(["Item #1", "Item #2", "Item #5"]);
      });

      // still fails in React 17 (does it?)
      expect(renders).toEqual(["list", "list", "item 1", "item 2", "item 5"]);

      act(() => {
        cache.writeFragment({
          fragment: ItemFragment,
          data: {
            __typename: "Item",
            id: 2,
            text: "Item #2 updated",
          },
        });
      });

      await waitFor(() => {
        expect(getItemTexts()).toEqual([
          "Item #1",
          "Item #2 updated",
          "Item #5",
        ]);
      });

      expect(renders).toEqual([
        "list",
        "list",
        "item 1",
        "item 2",
        "item 5",
        // Only the second item should have re-rendered.
        "item 2",
        /// broken test
        // "list", // why do these re-render again here
        // "item 1",
        // "item 2",
        // "item 5",
      ]);

      // act(() => {
      //   cache.modify({
      //     fields: {
      //       list(list: Reference[], { readField }) {
      //         return [
      //           ...list,
      //           cache.writeFragment({
      //             fragment: ItemFragment,
      //             data: {
      //               __typename: "Item",
      //               id: 3,
      //             },
      //           })!,
      //           cache.writeFragment({
      //             fragment: ItemFragment,
      //             data: {
      //               __typename: "Item",
      //               id: 4,
      //             },
      //           })!,
      //         ].sort(
      //           (ref1, ref2) =>
      //             readField<Item["id"]>("id", ref1)! -
      //             readField<Item["id"]>("id", ref2)!
      //         );
      //       },
      //     },
      //   });
      // });

      // await waitFor(() => {
      //   expect(getItemTexts()).toEqual([
      //     "Item #1",
      //     "Item #2 updated",
      //     "Item #3",
      //     "Item #4",
      //     "Item #5",
      //   ]);
      // });

      // expect(renders).toEqual([
      //   "list",
      //   "list",
      //   "item 1",
      //   "item 2",
      //   "item 5",
      //   "item 2",
      //   // This is what's new:
      //   "list",
      //   "item 1",
      //   "item 2",
      //   "item 3",
      //   "item 4",
      //   "item 5",
      // ]);

      // act(() => {
      //   cache.writeFragment({
      //     fragment: ItemFragment,
      //     data: {
      //       __typename: "Item",
      //       id: 4,
      //       text: "Item #4 updated",
      //     },
      //   });
      // });

      // await waitFor(() => {
      //   expect(getItemTexts()).toEqual([
      //     "Item #1",
      //     "Item #2 updated",
      //     "Item #3",
      //     "Item #4 updated",
      //     "Item #5",
      //   ]);
      // });

      // expect(renders).toEqual([
      //   "list",
      //   "list",
      //   "item 1",
      //   "item 2",
      //   "item 5",
      //   "item 2",
      //   "list",
      //   "item 1",
      //   "item 2",
      //   "item 3",
      //   "item 4",
      //   "item 5",
      //   // Only the fourth item should have re-rendered.
      //   "item 4",
      // ]);

      // expect(cache.extract()).toMatchSnapshot();

      resolve();
    }
  );
});
