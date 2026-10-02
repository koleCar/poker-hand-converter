export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      board_moderators: {
        Row: {
          board_id: string
          granted_at: string
          granted_by: string | null
          user_id: string
        }
        Insert: {
          board_id: string
          granted_at?: string
          granted_by?: string | null
          user_id: string
        }
        Update: {
          board_id?: string
          granted_at?: string
          granted_by?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "board_moderators_board_fk"
            columns: ["board_id"]
            isOneToOne: false
            referencedRelation: "boards"
            referencedColumns: ["id"]
          },
        ]
      }
      boards: {
        Row: {
          created_at: string
          description: string | null
          id: string
          is_locked: boolean
          name: string
          slug: string
          sort_order: number
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          is_locked?: boolean
          name: string
          slug: string
          sort_order?: number
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          is_locked?: boolean
          name?: string
          slug?: string
          sort_order?: number
        }
        Relationships: []
      }
      comment_votes: {
        Row: {
          comment_id: string
          created_at: string
          user_id: string
          value: number
          weight: number
        }
        Insert: {
          comment_id: string
          created_at?: string
          user_id: string
          value: number
          weight: number
        }
        Update: {
          comment_id?: string
          created_at?: string
          user_id?: string
          value?: number
          weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "comment_votes_comment_id_fkey"
            columns: ["comment_id"]
            isOneToOne: false
            referencedRelation: "comments"
            referencedColumns: ["id"]
          },
        ]
      }
      comments: {
        Row: {
          anchor_action_index: number | null
          anchor_seat: number | null
          anchor_street: string | null
          author_id: string | null
          best_rank: number | null
          body: string | null
          body_fingerprint: string | null
          created_at: string
          deleted_at: string | null
          depth: number | null
          downvotes: number
          edited_at: string | null
          id: string
          lang: unknown
          parent_id: string | null
          path: string
          post_id: string
          score: number
          search_tsv: unknown
          seq: number
          status: string
          upvotes: number
        }
        Insert: {
          anchor_action_index?: number | null
          anchor_seat?: number | null
          anchor_street?: string | null
          author_id?: string | null
          best_rank?: number | null
          body?: string | null
          body_fingerprint?: string | null
          created_at?: string
          deleted_at?: string | null
          depth?: number | null
          downvotes?: number
          edited_at?: string | null
          id?: string
          lang?: unknown
          parent_id?: string | null
          path: string
          post_id: string
          score?: number
          search_tsv?: unknown
          seq: number
          status?: string
          upvotes?: number
        }
        Update: {
          anchor_action_index?: number | null
          anchor_seat?: number | null
          anchor_street?: string | null
          author_id?: string | null
          best_rank?: number | null
          body?: string | null
          body_fingerprint?: string | null
          created_at?: string
          deleted_at?: string | null
          depth?: number | null
          downvotes?: number
          edited_at?: string | null
          id?: string
          lang?: unknown
          parent_id?: string | null
          path?: string
          post_id?: string
          score?: number
          search_tsv?: unknown
          seq?: number
          status?: string
          upvotes?: number
        }
        Relationships: [
          {
            foreignKeyName: "comments_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comments_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      content_revisions: {
        Row: {
          body: string | null
          comment_id: string | null
          created_at: string
          edited_by: string | null
          id: number
          post_id: string
          target_type: string
          title: string | null
        }
        Insert: {
          body?: string | null
          comment_id?: string | null
          created_at?: string
          edited_by?: string | null
          id?: never
          post_id: string
          target_type: string
          title?: string | null
        }
        Update: {
          body?: string | null
          comment_id?: string | null
          created_at?: string
          edited_by?: string | null
          id?: never
          post_id?: string
          target_type?: string
          title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "content_revisions_comment_id_fkey"
            columns: ["comment_id"]
            isOneToOne: false
            referencedRelation: "comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_revisions_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      hand_stats: {
        Row: {
          bet_flop: number
          bet_river: number
          bet_turn: number
          big_blind: number | null
          call_cbet_flop: number
          call_cbet_river: number
          call_cbet_turn: number
          call_flop: number
          call_four_bet: number
          call_river: number
          call_steal: number
          call_three_bet: number
          call_turn: number
          cashed_out: number
          cashout_risk: number
          cbet_flop: number
          cbet_flop_opp: number
          cbet_river: number
          cbet_river_opp: number
          cbet_turn: number
          cbet_turn_opp: number
          check_flop: number
          check_raise_flop: number
          check_raise_flop_opp: number
          check_raise_river: number
          check_raise_river_opp: number
          check_raise_turn: number
          check_raise_turn_opp: number
          check_river: number
          check_turn: number
          cold_call: number
          cold_call_opp: number
          contributed: number
          created_at: string
          currency: string
          currency_minor_units: number
          donk_flop: number
          donk_flop_opp: number
          donk_river: number
          donk_river_opp: number
          donk_turn: number
          donk_turn_opp: number
          fast_fold: string | null
          fees: number | null
          five_bet: number
          five_bet_opp: number
          flop_seen: number
          fold_flop: number
          fold_river: number
          fold_to_cbet_flop: number
          fold_to_cbet_flop_opp: number
          fold_to_cbet_river: number
          fold_to_cbet_river_opp: number
          fold_to_cbet_turn: number
          fold_to_cbet_turn_opp: number
          fold_to_four_bet: number
          fold_to_four_bet_opp: number
          fold_to_steal: number
          fold_to_steal_opp: number
          fold_to_three_bet: number
          fold_to_three_bet_opp: number
          fold_turn: number
          four_bet: number
          four_bet_opp: number
          game_format: Database["public"]["Enums"]["game_format"]
          hand_class: string | null
          hand_id: string
          hand_key: string
          hands: number
          has_cashout: boolean
          has_straddle: boolean
          hole_cards: string[]
          house_into_pot: number | null
          is_big_blind_ante: boolean
          is_bomb_pot: boolean
          is_hero: boolean
          is_run_it_twice: boolean
          is_walk: boolean
          iso: number
          iso_opp: number
          limit_type: string | null
          limp: number
          limp_opp: number
          max_seats: number | null
          net: number
          net_bb_milli: number
          out_of_pot: number
          owner_id: string
          pfr: number
          pfr_opp: number
          played_at: string | null
          player: string
          player_count: number | null
          position: string | null
          pot_type: string | null
          raise_cbet_flop: number
          raise_cbet_river: number
          raise_cbet_turn: number
          raise_flop: number
          raise_river: number
          raise_turn: number
          raise_vs_four_bet: number
          raise_vs_three_bet: number
          rake_paid: number
          rfi: number
          rfi_opp: number
          river_seen: number
          seat: number
          site_anonymization: Database["public"]["Enums"]["site_anonymization"]
          site_hand_id: string | null
          site_id: string
          small_blind: number | null
          squeeze: number
          squeeze_opp: number
          starting_stack: number | null
          starting_stack_bb_tenths: number | null
          stats_version: string
          steal: number
          steal_opp: number
          street_reached: string | null
          table_name: string | null
          three_bet: number
          three_bet_opp: number
          three_bet_vs_steal: number
          total_pot: number | null
          tournament_id: string | null
          turn_seen: number
          variant: string | null
          vpip: number
          vpip_opp: number
          won: number
          wsd: number
          wsd_opp: number
          wtsd: number
          wtsd_opp: number
          wwsf: number
          wwsf_opp: number
        }
        Insert: {
          bet_flop?: number
          bet_river?: number
          bet_turn?: number
          big_blind?: number | null
          call_cbet_flop?: number
          call_cbet_river?: number
          call_cbet_turn?: number
          call_flop?: number
          call_four_bet?: number
          call_river?: number
          call_steal?: number
          call_three_bet?: number
          call_turn?: number
          cashed_out?: number
          cashout_risk?: number
          cbet_flop?: number
          cbet_flop_opp?: number
          cbet_river?: number
          cbet_river_opp?: number
          cbet_turn?: number
          cbet_turn_opp?: number
          check_flop?: number
          check_raise_flop?: number
          check_raise_flop_opp?: number
          check_raise_river?: number
          check_raise_river_opp?: number
          check_raise_turn?: number
          check_raise_turn_opp?: number
          check_river?: number
          check_turn?: number
          cold_call?: number
          cold_call_opp?: number
          contributed?: number
          created_at?: string
          currency?: string
          currency_minor_units?: number
          donk_flop?: number
          donk_flop_opp?: number
          donk_river?: number
          donk_river_opp?: number
          donk_turn?: number
          donk_turn_opp?: number
          fast_fold?: string | null
          fees?: number | null
          five_bet?: number
          five_bet_opp?: number
          flop_seen?: number
          fold_flop?: number
          fold_river?: number
          fold_to_cbet_flop?: number
          fold_to_cbet_flop_opp?: number
          fold_to_cbet_river?: number
          fold_to_cbet_river_opp?: number
          fold_to_cbet_turn?: number
          fold_to_cbet_turn_opp?: number
          fold_to_four_bet?: number
          fold_to_four_bet_opp?: number
          fold_to_steal?: number
          fold_to_steal_opp?: number
          fold_to_three_bet?: number
          fold_to_three_bet_opp?: number
          fold_turn?: number
          four_bet?: number
          four_bet_opp?: number
          game_format?: Database["public"]["Enums"]["game_format"]
          hand_class?: string | null
          hand_id: string
          hand_key: string
          hands?: number
          has_cashout?: boolean
          has_straddle?: boolean
          hole_cards?: string[]
          house_into_pot?: number | null
          is_big_blind_ante?: boolean
          is_bomb_pot?: boolean
          is_hero?: boolean
          is_run_it_twice?: boolean
          is_walk?: boolean
          iso?: number
          iso_opp?: number
          limit_type?: string | null
          limp?: number
          limp_opp?: number
          max_seats?: number | null
          net?: number
          net_bb_milli?: number
          out_of_pot?: number
          owner_id: string
          pfr?: number
          pfr_opp?: number
          played_at?: string | null
          player?: string
          player_count?: number | null
          position?: string | null
          pot_type?: string | null
          raise_cbet_flop?: number
          raise_cbet_river?: number
          raise_cbet_turn?: number
          raise_flop?: number
          raise_river?: number
          raise_turn?: number
          raise_vs_four_bet?: number
          raise_vs_three_bet?: number
          rake_paid?: number
          rfi?: number
          rfi_opp?: number
          river_seen?: number
          seat: number
          site_anonymization?: Database["public"]["Enums"]["site_anonymization"]
          site_hand_id?: string | null
          site_id: string
          small_blind?: number | null
          squeeze?: number
          squeeze_opp?: number
          starting_stack?: number | null
          starting_stack_bb_tenths?: number | null
          stats_version?: string
          steal?: number
          steal_opp?: number
          street_reached?: string | null
          table_name?: string | null
          three_bet?: number
          three_bet_opp?: number
          three_bet_vs_steal?: number
          total_pot?: number | null
          tournament_id?: string | null
          turn_seen?: number
          variant?: string | null
          vpip?: number
          vpip_opp?: number
          won?: number
          wsd?: number
          wsd_opp?: number
          wtsd?: number
          wtsd_opp?: number
          wwsf?: number
          wwsf_opp?: number
        }
        Update: {
          bet_flop?: number
          bet_river?: number
          bet_turn?: number
          big_blind?: number | null
          call_cbet_flop?: number
          call_cbet_river?: number
          call_cbet_turn?: number
          call_flop?: number
          call_four_bet?: number
          call_river?: number
          call_steal?: number
          call_three_bet?: number
          call_turn?: number
          cashed_out?: number
          cashout_risk?: number
          cbet_flop?: number
          cbet_flop_opp?: number
          cbet_river?: number
          cbet_river_opp?: number
          cbet_turn?: number
          cbet_turn_opp?: number
          check_flop?: number
          check_raise_flop?: number
          check_raise_flop_opp?: number
          check_raise_river?: number
          check_raise_river_opp?: number
          check_raise_turn?: number
          check_raise_turn_opp?: number
          check_river?: number
          check_turn?: number
          cold_call?: number
          cold_call_opp?: number
          contributed?: number
          created_at?: string
          currency?: string
          currency_minor_units?: number
          donk_flop?: number
          donk_flop_opp?: number
          donk_river?: number
          donk_river_opp?: number
          donk_turn?: number
          donk_turn_opp?: number
          fast_fold?: string | null
          fees?: number | null
          five_bet?: number
          five_bet_opp?: number
          flop_seen?: number
          fold_flop?: number
          fold_river?: number
          fold_to_cbet_flop?: number
          fold_to_cbet_flop_opp?: number
          fold_to_cbet_river?: number
          fold_to_cbet_river_opp?: number
          fold_to_cbet_turn?: number
          fold_to_cbet_turn_opp?: number
          fold_to_four_bet?: number
          fold_to_four_bet_opp?: number
          fold_to_steal?: number
          fold_to_steal_opp?: number
          fold_to_three_bet?: number
          fold_to_three_bet_opp?: number
          fold_turn?: number
          four_bet?: number
          four_bet_opp?: number
          game_format?: Database["public"]["Enums"]["game_format"]
          hand_class?: string | null
          hand_id?: string
          hand_key?: string
          hands?: number
          has_cashout?: boolean
          has_straddle?: boolean
          hole_cards?: string[]
          house_into_pot?: number | null
          is_big_blind_ante?: boolean
          is_bomb_pot?: boolean
          is_hero?: boolean
          is_run_it_twice?: boolean
          is_walk?: boolean
          iso?: number
          iso_opp?: number
          limit_type?: string | null
          limp?: number
          limp_opp?: number
          max_seats?: number | null
          net?: number
          net_bb_milli?: number
          out_of_pot?: number
          owner_id?: string
          pfr?: number
          pfr_opp?: number
          played_at?: string | null
          player?: string
          player_count?: number | null
          position?: string | null
          pot_type?: string | null
          raise_cbet_flop?: number
          raise_cbet_river?: number
          raise_cbet_turn?: number
          raise_flop?: number
          raise_river?: number
          raise_turn?: number
          raise_vs_four_bet?: number
          raise_vs_three_bet?: number
          rake_paid?: number
          rfi?: number
          rfi_opp?: number
          river_seen?: number
          seat?: number
          site_anonymization?: Database["public"]["Enums"]["site_anonymization"]
          site_hand_id?: string | null
          site_id?: string
          small_blind?: number | null
          squeeze?: number
          squeeze_opp?: number
          starting_stack?: number | null
          starting_stack_bb_tenths?: number | null
          stats_version?: string
          steal?: number
          steal_opp?: number
          street_reached?: string | null
          table_name?: string | null
          three_bet?: number
          three_bet_opp?: number
          three_bet_vs_steal?: number
          total_pot?: number | null
          tournament_id?: string | null
          turn_seen?: number
          variant?: string | null
          vpip?: number
          vpip_opp?: number
          won?: number
          wsd?: number
          wsd_opp?: number
          wtsd?: number
          wtsd_opp?: number
          wwsf?: number
          wwsf_opp?: number
        }
        Relationships: [
          {
            foreignKeyName: "hand_stats_hand_id_fkey"
            columns: ["hand_id"]
            isOneToOne: false
            referencedRelation: "hands"
            referencedColumns: ["id"]
          },
        ]
      }
      hand_stats_ev: {
        Row: {
          applicable: boolean
          created_at: string
          ev_net: number
          ev_net_bb_milli: number
          ev_version: string
          hand_id: string
          hand_key: string
          owner_id: string
          seat: number
        }
        Insert: {
          applicable: boolean
          created_at?: string
          ev_net: number
          ev_net_bb_milli: number
          ev_version: string
          hand_id: string
          hand_key: string
          owner_id: string
          seat: number
        }
        Update: {
          applicable?: boolean
          created_at?: string
          ev_net?: number
          ev_net_bb_milli?: number
          ev_version?: string
          hand_id?: string
          hand_key?: string
          owner_id?: string
          seat?: number
        }
        Relationships: [
          {
            foreignKeyName: "hand_stats_ev_hand_id_fkey"
            columns: ["hand_id"]
            isOneToOne: false
            referencedRelation: "hands"
            referencedColumns: ["id"]
          },
        ]
      }
      hands: {
        Row: {
          ante: number | null
          big_blind: number | null
          board_cards: string[]
          created_at: string
          currency: string
          currency_minor_units: number
          currency_symbol: string | null
          fast_fold: string | null
          game_format: Database["public"]["Enums"]["game_format"]
          hand_key: string
          hero_cards: string[]
          hero_hand_class: string | null
          hero_name: string | null
          hero_position: string | null
          hero_profit: number | null
          hero_seat: number | null
          id: string
          limit_type: string | null
          max_seats: number | null
          owner_id: string
          parser_version: string | null
          phf: Json
          played_at: string | null
          player_count: number | null
          player_names: string[]
          player_positions: string[]
          rake: number | null
          schema_version: string
          showdown_positions: string[]
          site: string
          site_anonymization: Database["public"]["Enums"]["site_anonymization"]
          site_hand_id: string | null
          small_blind: number | null
          source_filename: string | null
          source_text: string | null
          stakes_label: string | null
          standard_text: string
          street_reached: string | null
          table_name: string | null
          total_pot: number | null
          tournament_id: string | null
          variant: string | null
          went_to_showdown: boolean
          winner_positions: string[]
          winners: string[]
        }
        Insert: {
          ante?: number | null
          big_blind?: number | null
          board_cards?: string[]
          created_at?: string
          currency?: string
          currency_minor_units?: number
          currency_symbol?: string | null
          fast_fold?: string | null
          game_format?: Database["public"]["Enums"]["game_format"]
          hand_key: string
          hero_cards?: string[]
          hero_hand_class?: string | null
          hero_name?: string | null
          hero_position?: string | null
          hero_profit?: number | null
          hero_seat?: number | null
          id?: string
          limit_type?: string | null
          max_seats?: number | null
          owner_id: string
          parser_version?: string | null
          phf: Json
          played_at?: string | null
          player_count?: number | null
          player_names?: string[]
          player_positions?: string[]
          rake?: number | null
          schema_version?: string
          showdown_positions?: string[]
          site: string
          site_anonymization?: Database["public"]["Enums"]["site_anonymization"]
          site_hand_id?: string | null
          small_blind?: number | null
          source_filename?: string | null
          source_text?: string | null
          stakes_label?: string | null
          standard_text: string
          street_reached?: string | null
          table_name?: string | null
          total_pot?: number | null
          tournament_id?: string | null
          variant?: string | null
          went_to_showdown?: boolean
          winner_positions?: string[]
          winners?: string[]
        }
        Update: {
          ante?: number | null
          big_blind?: number | null
          board_cards?: string[]
          created_at?: string
          currency?: string
          currency_minor_units?: number
          currency_symbol?: string | null
          fast_fold?: string | null
          game_format?: Database["public"]["Enums"]["game_format"]
          hand_key?: string
          hero_cards?: string[]
          hero_hand_class?: string | null
          hero_name?: string | null
          hero_position?: string | null
          hero_profit?: number | null
          hero_seat?: number | null
          id?: string
          limit_type?: string | null
          max_seats?: number | null
          owner_id?: string
          parser_version?: string | null
          phf?: Json
          played_at?: string | null
          player_count?: number | null
          player_names?: string[]
          player_positions?: string[]
          rake?: number | null
          schema_version?: string
          showdown_positions?: string[]
          site?: string
          site_anonymization?: Database["public"]["Enums"]["site_anonymization"]
          site_hand_id?: string | null
          small_blind?: number | null
          source_filename?: string | null
          source_text?: string | null
          stakes_label?: string | null
          standard_text?: string
          street_reached?: string | null
          table_name?: string | null
          total_pot?: number | null
          tournament_id?: string | null
          variant?: string | null
          went_to_showdown?: boolean
          winner_positions?: string[]
          winners?: string[]
        }
        Relationships: []
      }
      ingest_rate_limit: {
        Row: {
          bucket: string
          hits: number
          window_start: string
        }
        Insert: {
          bucket: string
          hits?: number
          window_start?: string
        }
        Update: {
          bucket?: string
          hits?: number
          window_start?: string
        }
        Relationships: []
      }
      moderation_actions: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          details: Json
          id: number
          reason: string | null
          subject_id: string | null
          target_id: string
          target_type: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          details?: Json
          id?: never
          reason?: string | null
          subject_id?: string | null
          target_id: string
          target_type: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          details?: Json
          id?: never
          reason?: string | null
          subject_id?: string | null
          target_id?: string
          target_type?: string
        }
        Relationships: []
      }
      notifications: {
        Row: {
          actor_id: string | null
          comment_id: string | null
          created_at: string
          id: number
          kind: string
          post_id: string
          read_at: string | null
          user_id: string
        }
        Insert: {
          actor_id?: string | null
          comment_id?: string | null
          created_at?: string
          id?: never
          kind: string
          post_id: string
          read_at?: string | null
          user_id: string
        }
        Update: {
          actor_id?: string | null
          comment_id?: string | null
          created_at?: string
          id?: never
          kind?: string
          post_id?: string
          read_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_comment_id_fkey"
            columns: ["comment_id"]
            isOneToOne: false
            referencedRelation: "comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      player_notes: {
        Row: {
          note: string
          owner_id: string
          player: string
          site: string
          tags: string[]
          updated_at: string
        }
        Insert: {
          note?: string
          owner_id: string
          player: string
          site: string
          tags?: string[]
          updated_at?: string
        }
        Update: {
          note?: string
          owner_id?: string
          player?: string
          site?: string
          tags?: string[]
          updated_at?: string
        }
        Relationships: []
      }
      poll_votes: {
        Row: {
          choice: string
          created_at: string
          post_id: string
          size_pct: number | null
          user_id: string
        }
        Insert: {
          choice: string
          created_at?: string
          post_id: string
          size_pct?: number | null
          user_id: string
        }
        Update: {
          choice?: string
          created_at?: string
          post_id?: string
          size_pct?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "poll_votes_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "post_polls"
            referencedColumns: ["post_id"]
          },
        ]
      }
      post_polls: {
        Row: {
          created_at: string
          hide_hero_cards: boolean
          options: string[]
          post_id: string
          published_hand_id: string
          stop_index: number
        }
        Insert: {
          created_at?: string
          hide_hero_cards?: boolean
          options: string[]
          post_id: string
          published_hand_id: string
          stop_index: number
        }
        Update: {
          created_at?: string
          hide_hero_cards?: boolean
          options?: string[]
          post_id?: string
          published_hand_id?: string
          stop_index?: number
        }
        Relationships: [
          {
            foreignKeyName: "post_polls_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: true
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_polls_published_hand_id_fkey"
            columns: ["published_hand_id"]
            isOneToOne: false
            referencedRelation: "published_hands"
            referencedColumns: ["id"]
          },
        ]
      }
      post_votes: {
        Row: {
          created_at: string
          post_id: string
          user_id: string
          value: number
          weight: number
        }
        Insert: {
          created_at?: string
          post_id: string
          user_id: string
          value: number
          weight: number
        }
        Update: {
          created_at?: string
          post_id?: string
          user_id?: string
          value?: number
          weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "post_votes_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      posts: {
        Row: {
          author_id: string | null
          board_id: string
          body: string
          body_fingerprint: string | null
          comment_count: number
          controversy: number | null
          created_at: string
          deleted_at: string | null
          downvotes: number
          edited_at: string | null
          hot_rank: number | null
          id: string
          is_locked: boolean
          is_pinned: boolean
          kind: string
          lang: unknown
          last_comment_seq: number
          public_id: string
          published_hand_id: string | null
          score: number
          search_tsv: unknown
          slug: string | null
          status: string
          title: string
          upvotes: number
        }
        Insert: {
          author_id?: string | null
          board_id: string
          body?: string
          body_fingerprint?: string | null
          comment_count?: number
          controversy?: number | null
          created_at?: string
          deleted_at?: string | null
          downvotes?: number
          edited_at?: string | null
          hot_rank?: number | null
          id?: string
          is_locked?: boolean
          is_pinned?: boolean
          kind: string
          lang?: unknown
          last_comment_seq?: number
          public_id: string
          published_hand_id?: string | null
          score?: number
          search_tsv?: unknown
          slug?: string | null
          status?: string
          title: string
          upvotes?: number
        }
        Update: {
          author_id?: string | null
          board_id?: string
          body?: string
          body_fingerprint?: string | null
          comment_count?: number
          controversy?: number | null
          created_at?: string
          deleted_at?: string | null
          downvotes?: number
          edited_at?: string | null
          hot_rank?: number | null
          id?: string
          is_locked?: boolean
          is_pinned?: boolean
          kind?: string
          lang?: unknown
          last_comment_seq?: number
          public_id?: string
          published_hand_id?: string | null
          score?: number
          search_tsv?: unknown
          slug?: string | null
          status?: string
          title?: string
          upvotes?: number
        }
        Relationships: [
          {
            foreignKeyName: "posts_board_id_fkey"
            columns: ["board_id"]
            isOneToOne: false
            referencedRelation: "boards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "posts_published_hand_id_fkey"
            columns: ["published_hand_id"]
            isOneToOne: false
            referencedRelation: "published_hands"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          ban_reason: string | null
          banned_until: string | null
          created_at: string
          digest: string
          id: string
          is_shadowbanned: boolean
          karma: number
          role: Database["public"]["Enums"]["profile_role"]
          unsubscribe_token: string
          username: string
          username_changed_at: string | null
          username_lower: string | null
        }
        Insert: {
          ban_reason?: string | null
          banned_until?: string | null
          created_at?: string
          digest?: string
          id: string
          is_shadowbanned?: boolean
          karma?: number
          role?: Database["public"]["Enums"]["profile_role"]
          unsubscribe_token?: string
          username: string
          username_changed_at?: string | null
          username_lower?: string | null
        }
        Update: {
          ban_reason?: string | null
          banned_until?: string | null
          created_at?: string
          digest?: string
          id?: string
          is_shadowbanned?: boolean
          karma?: number
          role?: Database["public"]["Enums"]["profile_role"]
          unsubscribe_token?: string
          username?: string
          username_changed_at?: string | null
          username_lower?: string | null
        }
        Relationships: []
      }
      publish_blocked_sites: {
        Row: {
          created_at: string
          reason: string | null
          site: string
        }
        Insert: {
          created_at?: string
          reason?: string | null
          site: string
        }
        Update: {
          created_at?: string
          reason?: string | null
          site?: string
        }
        Relationships: []
      }
      published_hand_sources: {
        Row: {
          author_id: string
          hand_id: string | null
          published_id: string
        }
        Insert: {
          author_id: string
          hand_id?: string | null
          published_id: string
        }
        Update: {
          author_id?: string
          hand_id?: string | null
          published_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "published_hand_sources_hand_id_fkey"
            columns: ["hand_id"]
            isOneToOne: false
            referencedRelation: "hands"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "published_hand_sources_published_id_fkey"
            columns: ["published_id"]
            isOneToOne: true
            referencedRelation: "published_hands"
            referencedColumns: ["id"]
          },
        ]
      }
      published_hands: {
        Row: {
          ante: number | null
          author_id: string | null
          big_blind: number | null
          board_cards: string[]
          created_at: string
          currency: string | null
          currency_minor_units: number | null
          currency_symbol: string | null
          deleted_at: string | null
          fast_fold: string | null
          game_format: Database["public"]["Enums"]["game_format"]
          hero_cards: string[]
          hero_hand_class: string | null
          hero_position: string | null
          hero_profit: number | null
          id: string
          limit_type: string | null
          max_seats: number | null
          mode: Database["public"]["Enums"]["publish_mode"]
          phf: Json
          played_on: string | null
          player_count: number | null
          public_id: string
          site: string
          site_anonymization: Database["public"]["Enums"]["site_anonymization"]
          small_blind: number | null
          stakes_label: string | null
          status: string
          street_reached: string | null
          title: string | null
          total_pot: number | null
          variant: string | null
          went_to_showdown: boolean | null
        }
        Insert: {
          ante?: number | null
          author_id?: string | null
          big_blind?: number | null
          board_cards?: string[]
          created_at?: string
          currency?: string | null
          currency_minor_units?: number | null
          currency_symbol?: string | null
          deleted_at?: string | null
          fast_fold?: string | null
          game_format?: Database["public"]["Enums"]["game_format"]
          hero_cards?: string[]
          hero_hand_class?: string | null
          hero_position?: string | null
          hero_profit?: number | null
          id?: string
          limit_type?: string | null
          max_seats?: number | null
          mode: Database["public"]["Enums"]["publish_mode"]
          phf: Json
          played_on?: string | null
          player_count?: number | null
          public_id: string
          site: string
          site_anonymization?: Database["public"]["Enums"]["site_anonymization"]
          small_blind?: number | null
          stakes_label?: string | null
          status?: string
          street_reached?: string | null
          title?: string | null
          total_pot?: number | null
          variant?: string | null
          went_to_showdown?: boolean | null
        }
        Update: {
          ante?: number | null
          author_id?: string | null
          big_blind?: number | null
          board_cards?: string[]
          created_at?: string
          currency?: string | null
          currency_minor_units?: number | null
          currency_symbol?: string | null
          deleted_at?: string | null
          fast_fold?: string | null
          game_format?: Database["public"]["Enums"]["game_format"]
          hero_cards?: string[]
          hero_hand_class?: string | null
          hero_position?: string | null
          hero_profit?: number | null
          id?: string
          limit_type?: string | null
          max_seats?: number | null
          mode?: Database["public"]["Enums"]["publish_mode"]
          phf?: Json
          played_on?: string | null
          player_count?: number | null
          public_id?: string
          site?: string
          site_anonymization?: Database["public"]["Enums"]["site_anonymization"]
          small_blind?: number | null
          stakes_label?: string | null
          status?: string
          street_reached?: string | null
          title?: string | null
          total_pot?: number | null
          variant?: string | null
          went_to_showdown?: boolean | null
        }
        Relationships: []
      }
      reports: {
        Row: {
          created_at: string
          details: string | null
          id: number
          reason: string
          reporter_id: string | null
          resolution: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: string
          subject_id: string
          subject_type: string
        }
        Insert: {
          created_at?: string
          details?: string | null
          id?: never
          reason: string
          reporter_id?: string | null
          resolution?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          subject_id: string
          subject_type: string
        }
        Update: {
          created_at?: string
          details?: string | null
          id?: never
          reason?: string
          reporter_id?: string | null
          resolution?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          subject_id?: string
          subject_type?: string
        }
        Relationships: []
      }
      saved_posts: {
        Row: {
          created_at: string
          post_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          post_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          post_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "saved_posts_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      shares: {
        Row: {
          created_at: string
          hand_id: string | null
          id: string
          last_viewed_at: string | null
          owner_id: string
          phf: Json | null
          slug: string
          spoilers: boolean
          standard_text: string | null
          title: string | null
          views: number
        }
        Insert: {
          created_at?: string
          hand_id?: string | null
          id?: string
          last_viewed_at?: string | null
          owner_id: string
          phf?: Json | null
          slug: string
          spoilers?: boolean
          standard_text?: string | null
          title?: string | null
          views?: number
        }
        Update: {
          created_at?: string
          hand_id?: string | null
          id?: string
          last_viewed_at?: string | null
          owner_id?: string
          phf?: Json | null
          slug?: string
          spoilers?: boolean
          standard_text?: string | null
          title?: string | null
          views?: number
        }
        Relationships: [
          {
            foreignKeyName: "shares_hand_id_fkey"
            columns: ["hand_id"]
            isOneToOne: false
            referencedRelation: "hands"
            referencedColumns: ["id"]
          },
        ]
      }
      thread_subscriptions: {
        Row: {
          created_at: string
          level: string
          post_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          level: string
          post_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          level?: string
          post_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "thread_subscriptions_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      unparsed_hands: {
        Row: {
          detected_site: string | null
          detection_confidence: number | null
          fingerprint: string
          first_seen_at: string
          id: string
          last_seen_at: string
          message: string
          notes: string | null
          occurrences: number
          parser_version: string
          raw_text: string
          reason: string
          source_filename: string | null
          stage: Database["public"]["Enums"]["conversion_stage"]
          status: Database["public"]["Enums"]["unparsed_status"]
          submitted_by: string | null
        }
        Insert: {
          detected_site?: string | null
          detection_confidence?: number | null
          fingerprint: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          message: string
          notes?: string | null
          occurrences?: number
          parser_version: string
          raw_text: string
          reason: string
          source_filename?: string | null
          stage: Database["public"]["Enums"]["conversion_stage"]
          status?: Database["public"]["Enums"]["unparsed_status"]
          submitted_by?: string | null
        }
        Update: {
          detected_site?: string | null
          detection_confidence?: number | null
          fingerprint?: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          message?: string
          notes?: string | null
          occurrences?: number
          parser_version?: string
          raw_text?: string
          reason?: string
          source_filename?: string | null
          stage?: Database["public"]["Enums"]["conversion_stage"]
          status?: Database["public"]["Enums"]["unparsed_status"]
          submitted_by?: string | null
        }
        Relationships: []
      }
      username_blocked_terms: {
        Row: {
          match: string
          term: string
        }
        Insert: {
          match: string
          term: string
        }
        Update: {
          match?: string
          term?: string
        }
        Relationships: []
      }
      username_reservations: {
        Row: {
          created_at: string
          expires_at: string | null
          reason: string
          reserved_for: string | null
          username_lower: string
        }
        Insert: {
          created_at?: string
          expires_at?: string | null
          reason: string
          reserved_for?: string | null
          username_lower: string
        }
        Update: {
          created_at?: string
          expires_at?: string | null
          reason?: string
          reserved_for?: string | null
          username_lower?: string
        }
        Relationships: []
      }
    }
    Views: {
      mod_vote_overlap: {
        Row: {
          same_direction: number | null
          shared_votes: number | null
          user_a: string | null
          user_b: string | null
        }
        Relationships: []
      }
      profiles_public: {
        Row: {
          id: string | null
          joined_on: string | null
          karma: number | null
          username: string | null
          username_lower: string | null
        }
        Insert: {
          id?: string | null
          joined_on?: never
          karma?: number | null
          username?: string | null
          username_lower?: string | null
        }
        Update: {
          id?: string | null
          joined_on?: never
          karma?: number | null
          username?: string | null
          username_lower?: string | null
        }
        Relationships: []
      }
      unparsed_gaps: {
        Row: {
          detected_site: string | null
          distinct_hands: number | null
          first_seen_at: string | null
          last_seen_at: string | null
          reason: string | null
          stage: Database["public"]["Enums"]["conversion_stage"] | null
          status: Database["public"]["Enums"]["unparsed_status"] | null
          total_occurrences: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      admin_create_board: {
        Args: { p_description?: string; p_name: string; p_slug: string }
        Returns: string
      }
      admin_purge: {
        Args: {
          p_public_id: string
          p_reason?: string
          p_seq?: number
          p_type: string
        }
        Returns: boolean
      }
      admin_set_board_moderator: {
        Args: { p_board: string; p_on: boolean; p_username: string }
        Returns: boolean
      }
      admin_set_role: {
        Args: {
          p_reason?: string
          p_role: Database["public"]["Enums"]["profile_role"]
          p_username: string
        }
        Returns: string
      }
      can_moderate_board: { Args: { p_board_id: string }; Returns: boolean }
      can_moderate_post: { Args: { p_public_id: string }; Returns: boolean }
      create_comment: {
        Args: {
          p_anchor_action?: number
          p_anchor_seat?: number
          p_anchor_street?: string
          p_body: string
          p_parent_seq?: number
          p_post_public_id: string
        }
        Returns: Json
      }
      create_poll_post: {
        Args: {
          p_board: string
          p_body: string
          p_hide_hero?: boolean
          p_options: string[]
          p_published_hand: string
          p_stop_index: number
          p_title: string
        }
        Returns: Json
      }
      create_post: {
        Args: {
          p_board: string
          p_body?: string
          p_published_hand?: string
          p_title: string
        }
        Returns: Json
      }
      create_share: {
        Args: {
          p_hand_id?: string
          p_phf?: Json
          p_spoilers?: boolean
          p_standard_text?: string
          p_title?: string
        }
        Returns: Json
      }
      delete_comment: {
        Args: { p_post_public_id: string; p_seq: number }
        Returns: boolean
      }
      delete_post: { Args: { p_public_id: string }; Returns: boolean }
      edit_comment: {
        Args: { p_body: string; p_post_public_id: string; p_seq: number }
        Returns: boolean
      }
      edit_post: {
        Args: { p_body: string; p_public_id: string; p_title: string }
        Returns: Json
      }
      enforce_rate_limit: {
        Args: {
          p_bucket: string
          p_cost: number
          p_limit: number
          p_window: string
        }
        Returns: undefined
      }
      fan_out_comment_notifications: {
        Args: { p_comment_id: string }
        Returns: number
      }
      forum_author_hidden: { Args: { p_author: string }; Returns: boolean }
      forum_best_rank: {
        Args: { p_down: number; p_up: number }
        Returns: number
      }
      forum_controversy: {
        Args: { p_down: number; p_up: number }
        Returns: number
      }
      forum_feed: {
        Args: {
          p_after?: string
          p_board?: string
          p_limit?: number
          p_sort?: string
        }
        Returns: Json
      }
      forum_fingerprint: { Args: { p_body: string }; Returns: string }
      forum_hot_rank: {
        Args: { p_created_at: string; p_score: number }
        Returns: number
      }
      forum_path_segment: { Args: { p_seq: number }; Returns: string }
      forum_post_json: {
        Args: { p: Database["public"]["Tables"]["posts"]["Row"] }
        Returns: Json
      }
      forum_recount_comment: {
        Args: { p_comment_id: string }
        Returns: undefined
      }
      forum_recount_karma: { Args: { p_user: string }; Returns: undefined }
      forum_recount_post: { Args: { p_post_id: string }; Returns: undefined }
      forum_slugify: { Args: { p_text: string }; Returns: string }
      forum_spam_verdict: {
        Args: { p_body: string; p_kind: string; p_uid: string }
        Returns: string
      }
      generate_share_slug: { Args: { p_length?: number }; Returns: string }
      get_hand: { Args: { p_id: string }; Returns: Json }
      get_post: { Args: { p_public_id: string }; Returns: Json }
      get_post_comments: {
        Args: { p_public_id: string; p_sort?: string }
        Returns: Json
      }
      get_revisions: {
        Args: { p_post_public_id: string; p_seq?: number }
        Returns: Json
      }
      hand_stats_counter_keys: { Args: never; Returns: string[] }
      hand_stats_filter_sql: { Args: never; Returns: string }
      hand_stats_money_keys: { Args: never; Returns: string[] }
      hands_facets: { Args: never; Returns: Json }
      hands_needing_stats: {
        Args: {
          p_after?: string
          p_ev_version?: string
          p_limit?: number
          p_version: string
          p_villains?: boolean
        }
        Returns: {
          id: string
          phf: Json
        }[]
      }
      is_admin: { Args: never; Returns: boolean }
      is_board_moderator: { Args: { p_board_id: string }; Returns: boolean }
      is_card_array: { Args: { p_cards: string[] }; Returns: boolean }
      is_moderator: { Args: never; Returns: boolean }
      is_position_array: { Args: { p_positions: string[] }; Returns: boolean }
      mark_notifications_read: { Args: { p_ids?: number[] }; Returns: number }
      mod_ban: {
        Args: { p_days: number; p_reason: string; p_username: string }
        Returns: Json
      }
      mod_edit_post_title: {
        Args: { p_public_id: string; p_reason?: string; p_title: string }
        Returns: Json
      }
      mod_post_for_update: {
        Args: { p_public_id: string }
        Returns: {
          author_id: string | null
          board_id: string
          body: string
          body_fingerprint: string | null
          comment_count: number
          controversy: number | null
          created_at: string
          deleted_at: string | null
          downvotes: number
          edited_at: string | null
          hot_rank: number | null
          id: string
          is_locked: boolean
          is_pinned: boolean
          kind: string
          lang: unknown
          last_comment_seq: number
          public_id: string
          published_hand_id: string | null
          score: number
          search_tsv: unknown
          slug: string | null
          status: string
          title: string
          upvotes: number
        }
        SetofOptions: {
          from: "*"
          to: "posts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      mod_queue: {
        Args: { p_limit?: number; p_status?: string }
        Returns: Json
      }
      mod_resolve_report: {
        Args: { p_id: number; p_note?: string; p_status: string }
        Returns: boolean
      }
      mod_set_comment_status: {
        Args: {
          p_post_public_id: string
          p_reason?: string
          p_seq: number
          p_status: string
        }
        Returns: string
      }
      mod_set_post_flags: {
        Args: {
          p_locked?: boolean
          p_pinned?: boolean
          p_public_id: string
          p_reason?: string
        }
        Returns: Json
      }
      mod_set_post_status: {
        Args: { p_public_id: string; p_reason?: string; p_status: string }
        Returns: string
      }
      mod_set_published_hand_status: {
        Args: { p_public_id: string; p_reason?: string; p_status: string }
        Returns: string
      }
      mod_shadowban: {
        Args: { p_on: boolean; p_reason?: string; p_username: string }
        Returns: boolean
      }
      mod_spam_queue: { Args: { p_limit?: number }; Returns: Json }
      mod_unban: {
        Args: { p_reason?: string; p_username: string }
        Returns: boolean
      }
      mod_user: { Args: { p_username: string }; Returns: Json }
      mod_vote_overlap_for: { Args: { p_username: string }; Returns: Json }
      my_comment_votes: { Args: { p_post_public_id: string }; Returns: Json }
      my_notifications: {
        Args: { p_before?: number; p_limit?: number }
        Returns: Json
      }
      my_player_notes: { Args: { p_site?: string }; Returns: Json }
      my_post_state: { Args: { p_public_id: string }; Returns: Json }
      my_post_votes: { Args: { p_public_ids: string[] }; Returns: Json }
      my_profile: { Args: never; Returns: Json }
      my_published_hand_ids: { Args: { p_hand_ids: string[] }; Returns: Json }
      my_saved_posts: {
        Args: { p_before?: string; p_limit?: number }
        Returns: Json
      }
      normalize_cards: { Args: { p_cards: string[] }; Returns: string[] }
      normalize_positions: {
        Args: { p_positions: string[] }
        Returns: string[]
      }
      phf_is_scrubbed: { Args: { p_phf: Json }; Returns: boolean }
      phf_redact_private: { Args: { p_phf: Json }; Returns: Json }
      phf_replace_names: {
        Args: { p_map: Json; p_text: string }
        Returns: string
      }
      poll_hides_answer: { Args: { p_post: string }; Returns: boolean }
      poll_phf: {
        Args: { p_hide_hero: boolean; p_phf: Json; p_stop: number }
        Returns: Json
      }
      poll_post_of_hand: { Args: { p_public_id: string }; Returns: Json }
      poll_public: { Args: { p_post: string }; Returns: Json }
      post_status: { Args: { p_public_id: string }; Returns: string }
      posting_block_reason: { Args: { p_uid: string }; Returns: string }
      provisional_username: { Args: never; Returns: string }
      prune_hand_stats: {
        Args: { p_keep_version: string; p_limit?: number }
        Returns: Json
      }
      prune_villain_stats: { Args: { p_limit?: number }; Returns: Json }
      publish_hand: {
        Args: {
          p_hand_id: string
          p_mode?: Database["public"]["Enums"]["publish_mode"]
          p_title?: string
        }
        Returns: Json
      }
      published_hand_status: { Args: { p_public_id: string }; Returns: string }
      published_hands_by_author: {
        Args: { p_before?: string; p_limit?: number; p_username: string }
        Returns: Json
      }
      read_poll: { Args: { p_post: string }; Returns: Json }
      read_published_hand: { Args: { p_public_id: string }; Returns: Json }
      read_share: { Args: { p_slug: string }; Returns: Json }
      record_conversion_failures: { Args: { p_failures: Json }; Returns: Json }
      record_share_view: { Args: { p_slug: string }; Returns: boolean }
      recount_forum_counters: { Args: never; Returns: Json }
      recount_forum_karma: { Args: never; Returns: number }
      report_content: {
        Args: {
          p_details?: string
          p_public_id?: string
          p_reason?: string
          p_seq?: number
          p_subject_type: string
          p_username?: string
        }
        Returns: Json
      }
      resolve_share: { Args: { p_slug: string }; Returns: Json }
      resolve_username: { Args: { p_username: string }; Returns: Json }
      save_hand_ev: { Args: { p_rows: Json }; Returns: Json }
      save_hand_stats: { Args: { p_rows: Json }; Returns: Json }
      save_hands: { Args: { p_hands: Json }; Returns: Json }
      save_post: {
        Args: { p_public_id: string; p_saved?: boolean }
        Returns: boolean
      }
      scrub_phf: {
        Args: {
          p_mode?: Database["public"]["Enums"]["publish_mode"]
          p_phf: Json
        }
        Returns: Json
      }
      search_forum: {
        Args: { p_limit?: number; p_query: string }
        Returns: Json
      }
      search_hands: {
        Args: { p_filters?: Json; p_limit?: number; p_offset?: number }
        Returns: Json
      }
      set_player_note: {
        Args: {
          p_note: string
          p_player: string
          p_site: string
          p_tags?: string[]
        }
        Returns: Json
      }
      set_thread_subscription: {
        Args: { p_level: string; p_public_id: string }
        Returns: string
      }
      set_username: { Args: { p_username: string }; Returns: Json }
      stats_breakdown: {
        Args: { p_filters?: Json; p_group?: string }
        Returns: Json
      }
      stats_coverage: { Args: { p_version: string }; Returns: Json }
      stats_empty_graph: { Args: { p_version: string }; Returns: Json }
      stats_empty_summary: { Args: { p_version: string }; Returns: Json }
      stats_ev_missing: {
        Args: { p_ev_version: string; p_version: string }
        Returns: number
      }
      stats_graph: {
        Args: { p_buckets?: number; p_filters?: Json }
        Returns: Json
      }
      stats_opponents: {
        Args: { p_filters?: Json; p_limit?: number; p_search?: string }
        Returns: Json
      }
      stats_sessions: {
        Args: { p_filters?: Json; p_gap_minutes?: number }
        Returns: Json
      }
      stats_summary: { Args: { p_filters?: Json }; Returns: Json }
      sweep_rate_limits: { Args: never; Returns: number }
      unparsed_summary: { Args: { p_limit?: number }; Returns: Json }
      unpublish_hand: { Args: { p_public_id: string }; Returns: boolean }
      unread_notification_count: { Args: never; Returns: number }
      username_fold: { Args: { p_name: string }; Returns: string }
      username_shape_problem: { Args: { p_name: string }; Returns: string }
      vote_comment: {
        Args: { p_post_public_id: string; p_seq: number; p_value: number }
        Returns: Json
      }
      vote_poll: {
        Args: { p_choice: string; p_post: string; p_size_pct?: number }
        Returns: Json
      }
      vote_post: {
        Args: { p_public_id: string; p_value: number }
        Returns: Json
      }
      vote_weight: { Args: { p_uid: string }; Returns: number }
    }
    Enums: {
      conversion_stage: "split" | "detect" | "parse" | "validate" | "serialize"
      game_format: "cash" | "tournament" | "sng" | "spin"
      profile_role: "member" | "moderator" | "admin"
      publish_mode: "pseudonyms" | "positions" | "as-imported"
      site_anonymization: "none" | "positional" | "opaque-id"
      unparsed_status: "new" | "triaged" | "parser-written" | "wontfix"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      conversion_stage: ["split", "detect", "parse", "validate", "serialize"],
      game_format: ["cash", "tournament", "sng", "spin"],
      profile_role: ["member", "moderator", "admin"],
      publish_mode: ["pseudonyms", "positions", "as-imported"],
      site_anonymization: ["none", "positional", "opaque-id"],
      unparsed_status: ["new", "triaged", "parser-written", "wontfix"],
    },
  },
} as const

