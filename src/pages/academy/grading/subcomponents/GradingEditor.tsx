import {
  Button,
  Dialog,
  Divider,
  H3,
  Icon,
  Intent,
  NumericInput,
  Position,
  Pre
} from '@blueprintjs/core';
import { IconNames } from '@blueprintjs/icons';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AutogradingResult, LLMPrompt } from 'src/commons/assessment/AssessmentTypes';
import { useTokens, useTypedDispatch, useTypedSelector } from 'src/commons/utils/Hooks';

import SessionActions from '../../../../commons/application/actions/SessionActions';
import ControlButton from '../../../../commons/ControlButton';
import { Prompt } from '../../../../commons/ReactRouterPrompt';
import { postGenerateComments, saveChosenComments } from '../../../../commons/sagas/RequestsSaga';
import { getPrettyDate } from '../../../../commons/utils/DateHelper';
import { showSimpleConfirmDialog } from '../../../../commons/utils/DialogHelper';
import {
  showSuccessMessage,
  showWarningMessage
} from '../../../../commons/utils/notifications/NotificationsHelper';
import { convertParamToInt } from '../../../../commons/utils/ParamParseHelper';
import GradingCommentSelector from './GradingCommentSelector';
import LLMFeedbackButton from './LLMFeedbackButton';

type GradingSaveFunction = (
  submissionId: number,
  questionId: number,
  xpAdjustment: number | undefined,
  comments?: string
) => void;

type Props = {
  prompts: LLMPrompt[];
  answer_id: number;
  solution: number | string | null;
  assessmentId: number;
  questionId: number;
  submissionId: number;
  initialXp: number;
  xpAdjustment: number;
  maxXp: number;
  studentNames: string[];
  studentUsernames: string[];
  is_llm: boolean;
  comments: string;
  autoGradingStatus: string;
  autoGradingResults: AutogradingResult[];
  studentAnswer: string | null;
  graderName?: string;
  gradedAt?: string;
  ai_comments?: {
    comments: string[];
    selectedIndices: number[];
    selectedEdits: Record<number, string>;
  };
};

const gradingEditorButtonClass = 'grading-editor-button';
const EMPTY_SELECTION_SAVE_KEY = JSON.stringify({ selected_indices: [], edits: {} });

const GradingEditor: React.FC<Props> = props => {
  const dispatch = useTypedDispatch();
  const tokens = useTokens();
  const prompts = props.prompts ?? [];
  const hasPrompts = prompts.length > 0;
  const gradingSaveResult = useTypedSelector(state => state.session.gradingSaveResult);
  const lastSavedSelectionKeyRef = useRef<string>(EMPTY_SELECTION_SAVE_KEY);
  const initialComposedCommentRef = useRef<string>(props.comments);
  const saveInFlightRef = useRef<boolean>(false);
  const saveAndContinueTimeoutRef = useRef<number | undefined>(undefined);
  const saveTimeoutRef = useRef<number | undefined>(undefined);
  const { handleGradingSave, handleGradingSaveAndContinue, handleReautogradeAnswer } = useMemo(
    () =>
      ({
        handleGradingSave: (...args) => dispatch(SessionActions.submitGrading(...args)),
        handleGradingSaveAndContinue: (...args) =>
          dispatch(SessionActions.submitGradingAndContinue(...args)),
        handleReautogradeAnswer: (...args) => dispatch(SessionActions.reautogradeAnswer(...args))
      }) satisfies {
        handleGradingSave: GradingSaveFunction;
        handleGradingSaveAndContinue: GradingSaveFunction;
        handleReautogradeAnswer: (submissionId: number, questionId: number) => void;
      },
    [dispatch]
  );

  /**
   * A potentially null string which defines the
   * result for the number XP input. This property being null
   * will show the hint text in the NumericInput. This property is a string
   * so as to allow input such as the '-' character.
   */
  const [xpAdjustmentInput, setXpAdjustmentInput] = useState<string | null>(
    props.xpAdjustment.toString()
  );
  /**
   * Determines whether the 'You have unsaved changes'
   * prompt should appear on page navigation, to prevent the
   * 'Save and Continue' button from activating the prompt
   * in cases where navigation occurs before Redux has
   * updated the props of the Editor component
   *
   * This may pose a problem if the user clicks 'Save and Continue'
   * and the saving process fails. The prompt would no longer
   * appear although there exist unsaved changes
   */
  const [currentlySaving, setCurrentlySaving] = useState(false);
  const [isSaveInFlight, setIsSaveInFlight] = useState(false);
  const [userComment, setUserComment] = useState<string>(props.comments);
  const [aiCommentDrafts, setAiCommentDrafts] = useState<Record<number, string>>({});
  const [editorText, setEditorText] = useState<string>(props.comments);

  useEffect(() => {
    makeInitialState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.submissionId, props.questionId]);

  // Unlock save controls once Redux props refresh after a save cycle.
  useEffect(() => {
    saveInFlightRef.current = false;
    setIsSaveInFlight(false);
    setCurrentlySaving(false);

    if (saveAndContinueTimeoutRef.current !== undefined) {
      window.clearTimeout(saveAndContinueTimeoutRef.current);
      saveAndContinueTimeoutRef.current = undefined;
    }
    if (saveTimeoutRef.current !== undefined) {
      window.clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = undefined;
    }
  }, [props.comments, props.xpAdjustment, props.gradedAt, props.submissionId, props.questionId]);

  useEffect(() => {
    if (
      !gradingSaveResult ||
      gradingSaveResult.submissionId !== props.submissionId ||
      gradingSaveResult.questionId !== props.questionId
    ) {
      return;
    }

    saveInFlightRef.current = false;
    setIsSaveInFlight(false);

    if (saveAndContinueTimeoutRef.current !== undefined) {
      window.clearTimeout(saveAndContinueTimeoutRef.current);
      saveAndContinueTimeoutRef.current = undefined;
    }
    if (saveTimeoutRef.current !== undefined) {
      window.clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = undefined;
    }

    if (!gradingSaveResult.success || !gradingSaveResult.saveAndContinue) {
      setCurrentlySaving(false);
    }
  }, [gradingSaveResult, props.questionId, props.submissionId]);

  const buildAiTextMap = (
    indices: number[],
    drafts: Record<number, string>
  ): Record<number, string> => {
    const map: Record<number, string> = {};
    indices.forEach(index => {
      const draft = drafts[index];
      if (draft !== undefined) {
        map[index] = draft;
      }
    });
    return map;
  };

  const composeFinalCommentText = (
    nextUserComment: string,
    indices: number[],
    drafts: Record<number, string>,
    baseSuggestions: string[]
  ): string => {
    const sections: string[] = [];

    if (nextUserComment.trim().length > 0) {
      sections.push(nextUserComment);
    }

    [...indices]
      .sort((a, b) => a - b)
      .forEach(index => {
        const text = drafts[index] ?? baseSuggestions[index] ?? '';
        if (text.trim().length > 0) {
          sections.push(text);
        }
      });

    return sections.join('\n\n');
  };

  const handleEditorTextChange = (newText: string) => {
    setEditorText(newText);

    const sorted = [...selectedIndices].sort((a, b) => a - b);
    if (sorted.length === 0) {
      setUserComment(newText);
      return;
    }

    const currentAiSections = sorted
      .map(idx => aiCommentDrafts[idx] ?? suggestions[idx] ?? '')
      .filter(section => section.trim().length > 0);
    const currentAiSuffix = currentAiSections.join('\n\n');

    // Fast path: if current AI suffix is untouched, only user comment changed.
    if (currentAiSuffix && newText.endsWith(currentAiSuffix)) {
      const userPart = newText.slice(0, -1 * currentAiSuffix.length).replace(/\n+$/, '');
      setUserComment(userPart);
      return;
    }

    // Fallback: parse by paragraph boundaries (2 or more newlines), preserving existing drafts
    // when parsing is ambiguous.
    const parts = newText.split(/\n{2,}/);
    if (parts.length < sorted.length + 1) {
      setUserComment(newText);
      return;
    }

    const aiStart = Math.max(0, parts.length - sorted.length);
    const userText = parts.slice(0, aiStart).join('\n\n');
    const aiParts = parts.slice(aiStart);

    setUserComment(userText);
    setAiCommentDrafts(prev => {
      const next = { ...prev };
      sorted.forEach((idx, i) => {
        next[idx] = aiParts[i] ?? next[idx] ?? suggestions[idx] ?? '';
      });
      return next;
    });
  };

  const onToggleComment = (index: number) => {
    const isDeselecting = selectedIndices.includes(index);

    if (isDeselecting) {
      const nextIndices = selectedIndices.filter(i => i !== index).sort((a, b) => a - b);
      setSelectedIndices(nextIndices);
      setEditorText(
        composeFinalCommentText(userComment, nextIndices, aiCommentDrafts, suggestions)
      );
      return;
    }

    const nextIndices = [...selectedIndices, index].sort((a, b) => a - b);
    setSelectedIndices(nextIndices);
    setAiCommentDrafts(prev => {
      const nextDrafts = { ...prev };
      if (nextDrafts[index] === undefined) {
        nextDrafts[index] = suggestions[index] ?? '';
      }

      setEditorText(composeFinalCommentText(userComment, nextIndices, nextDrafts, suggestions));
      return nextDrafts;
    });
  };

  const buildSelectionSaveKey = (
    indices: number[],
    texts: Record<number, string>,
    originals: string[]
  ): string => {
    const sortedSelectedIndices = [...indices].sort((a, b) => a - b);
    const changedEdits: Record<number, string> = {};

    sortedSelectedIndices.forEach(idx => {
      const original = originals[idx] ?? '';
      const edited = texts[idx] ?? original;
      if (edited !== original) {
        changedEdits[idx] = edited;
      }
    });

    return JSON.stringify({
      selected_indices: sortedSelectedIndices,
      edits: changedEdits
    });
  };

  const postSaveChosenComments = async (): Promise<boolean> => {
    // Only persist AI selections when this answer has generated suggestions.
    if (!props.is_llm || suggestions.length === 0) {
      return true;
    }

    const aiTextMap = buildAiTextMap(selectedIndices, aiCommentDrafts);

    const sortedSelectedIndices = [...selectedIndices].sort((a, b) => a - b);

    // Send only edits that differ from the original generated text.
    const changedEdits: Record<number, string> = {};
    sortedSelectedIndices.forEach(idx => {
      const original = suggestions[idx] ?? '';
      const edited = aiTextMap[idx] ?? original;
      if (edited !== original) {
        changedEdits[idx] = edited;
      }
    });

    const currentSelectionKey = buildSelectionSaveKey(
      sortedSelectedIndices,
      aiTextMap,
      suggestions
    );

    // Avoid rewriting identical selection state on repeated saves.
    if (currentSelectionKey === lastSavedSelectionKeyRef.current) {
      return true;
    }

    const resp = await saveChosenComments(
      tokens,
      props.answer_id,
      sortedSelectedIndices,
      changedEdits
    );

    if (!resp || !resp.ok) {
      showWarningMessage('Failed to save selected AI comments. Please try again.');
      return false;
    }

    lastSavedSelectionKeyRef.current = currentSelectionKey;

    return true;
  };

  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [selectedIndices, setSelectedIndices] = useState<number[]>([]);
  const [hasClickedGenerate, setHasClickedGenerate] = useState<boolean>(false);
  const [isViewLLMPromptOpen, setIsViewLLMPromptOpen] = useState<boolean>(false);
  const [hasGenerated, setHasGenerated] = useState<boolean>(false); //If generate comments button has been pressed

  const deriveUserCommentText = (savedComments: string, selectedTexts: string[]): string => {
    const normalizedSavedComments = savedComments.replace(/\r\n/g, '\n');

    if (selectedTexts.length === 0) {
      return normalizedSavedComments;
    }

    const joinedSingle = selectedTexts.join('\n');
    const joinedDouble = selectedTexts.join('\n\n');

    if (normalizedSavedComments === joinedSingle || normalizedSavedComments === joinedDouble) {
      return '';
    }

    if (joinedSingle && normalizedSavedComments.endsWith(`\n${joinedSingle}`)) {
      return normalizedSavedComments.slice(0, -1 * (joinedSingle.length + 1));
    }

    if (joinedDouble && normalizedSavedComments.endsWith(`\n\n${joinedDouble}`)) {
      return normalizedSavedComments.slice(0, -1 * (joinedDouble.length + 2));
    }

    return normalizedSavedComments;
  };

  const makeInitialState = () => {
    setXpAdjustmentInput(props.xpAdjustment.toString());
    setCurrentlySaving(false);
    // Load existing AI comments from props (the database)
    const existingComments = props.ai_comments?.comments || [];
    const persistedSelectedIndices = props.ai_comments?.selectedIndices || [];
    const persistedSelectedEdits = props.ai_comments?.selectedEdits || {};

    const validSelectedIndices = [...persistedSelectedIndices]
      .filter(index => index >= 0 && index < existingComments.length)
      .sort((a, b) => a - b);

    const hydratedCommentTexts: Record<number, string> = {};
    validSelectedIndices.forEach(index => {
      hydratedCommentTexts[index] = persistedSelectedEdits[index] ?? existingComments[index] ?? '';
    });

    const selectedTexts = validSelectedIndices.map(index => hydratedCommentTexts[index] ?? '');
    const restoredUserText = deriveUserCommentText(props.comments, selectedTexts);
    const restoredEditorText = composeFinalCommentText(
      restoredUserText,
      validSelectedIndices,
      hydratedCommentTexts,
      existingComments
    );

    setUserComment(restoredUserText);
    setAiCommentDrafts(hydratedCommentTexts);
    setEditorText(restoredEditorText);
    initialComposedCommentRef.current = restoredEditorText;
    setSuggestions(existingComments);
    // Lock the button if we already have comments for this submission
    setHasGenerated(existingComments.length > 0);
    setSelectedIndices(validSelectedIndices);
    lastSavedSelectionKeyRef.current = buildSelectionSaveKey(
      validSelectedIndices,
      hydratedCommentTexts,
      existingComments
    );
    if (saveAndContinueTimeoutRef.current !== undefined) {
      window.clearTimeout(saveAndContinueTimeoutRef.current);
      saveAndContinueTimeoutRef.current = undefined;
    }
  };

  /**
   * Makes sure that the XP values are permissible before
   * returning the relevant saving function (for the 'Save Draft'
   * and 'Submit and Continue' buttons)
   */
  const validateXpBeforeSave =
    (handleSaving: GradingSaveFunction): (() => void) =>
    async () => {
      if (saveInFlightRef.current) {
        return;
      }

      const newXpAdjustmentInput = convertParamToInt(xpAdjustmentInput || undefined) || undefined;
      const xp = props.initialXp + (newXpAdjustmentInput || 0);

      if (xp < 0 || xp > props.maxXp) {
        showWarningMessage(
          `XP ${xp.toString()} is out of bounds. Maximum xp is ${props.maxXp.toString()}.`
        );
        return;
      }

      const cleanedEditorValue = composeFinalCommentText(
        userComment,
        selectedIndices,
        aiCommentDrafts,
        suggestions
      );

      saveInFlightRef.current = true;
      setIsSaveInFlight(true);

      const hasSavedChosenComments = await postSaveChosenComments();
      if (!hasSavedChosenComments) {
        saveInFlightRef.current = false;
        setIsSaveInFlight(false);
        setCurrentlySaving(false);

        if (saveAndContinueTimeoutRef.current !== undefined) {
          window.clearTimeout(saveAndContinueTimeoutRef.current);
          saveAndContinueTimeoutRef.current = undefined;
        }
        return;
      }

      handleSaving(props.submissionId, props.questionId, newXpAdjustmentInput, cleanedEditorValue);
    };

  /**
   * Sets the state currentlySaving to true to disable
   * the 'You have unsaved changes' prompt
   */
  const onClickSaveAndContinue: GradingSaveFunction = (
    submissionId: number,
    questionId: number,
    xpAdjustment: number | undefined,
    comments?: string
  ) => {
    const callback = (): void => {
      handleGradingSaveAndContinue(submissionId, questionId, xpAdjustment, comments!);
    };
    setCurrentlySaving(true);
    if (saveAndContinueTimeoutRef.current !== undefined) {
      window.clearTimeout(saveAndContinueTimeoutRef.current);
    }
    if (saveTimeoutRef.current !== undefined) {
      window.clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = undefined;
    }
    // Fallback to avoid suppressing the unsaved-changes prompt indefinitely if save fails.
    saveAndContinueTimeoutRef.current = window.setTimeout(() => {
      setCurrentlySaving(false);
      saveInFlightRef.current = false;
      setIsSaveInFlight(false);
      saveAndContinueTimeoutRef.current = undefined;
    }, 15000);
    // TODO: Check (not sure how) if this results in a regression.
    callback();
  };

  const onClickSaveChanges: GradingSaveFunction = (
    submissionId: number,
    questionId: number,
    xpAdjustment: number | undefined,
    comments?: string
  ) => {
    const callback = (): void => {
      handleGradingSave(submissionId, questionId, xpAdjustment, comments!);
    };
    // Fallback timeout to unlock save controls if Redux state update doesn't occur
    // (e.g., if grading saga fails unexpectedly)
    if (saveTimeoutRef.current !== undefined) {
      window.clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = window.setTimeout(() => {
      saveInFlightRef.current = false;
      setIsSaveInFlight(false);
      saveTimeoutRef.current = undefined;
    }, 15000);
    callback();
  };

  const onClickReautogradeAnswer = async () => {
    const confirm = await showSimpleConfirmDialog({
      contents: (
        <>
          <p>Reautograde this answer?</p>
          <p>Note: manual adjustments will be reset to 0.</p>
        </>
      ),
      positiveLabel: 'Reautograde',
      positiveIntent: 'danger'
    });
    if (confirm) {
      handleReautogradeAnswer(props.submissionId, props.questionId);
    }
  };

  /**
   * Send a warning prompt that loading from a local draft
   * will overwrite any unsaved changes
   */
  const discardChanges = (): void => {
    if (!checkHasUnsavedChanges() || window.confirm('This will reset the editor. Are you sure?')) {
      makeInitialState();
      showSuccessMessage('Discarded!', 1000);
    }
  };

  /**
   * Handles changes in the XP NumericInput, and updates the local State.
   *
   * @param valueAsNumber an unused parameter, as we use strings for the input. @see State
   * @param valueAsString a string that contains the input. To be parsed by another function.
   */
  const onXpAdjustmentInputChange = (valueAsNumber: number, valueAsString: string | null) => {
    setXpAdjustmentInput(valueAsString);
  };

  const checkHasUnsavedChanges = () => {
    const newXpAdjustmentInput = convertParamToInt(xpAdjustmentInput || undefined);
    const normalizedEditorValue = composeFinalCommentText(
      userComment,
      selectedIndices,
      aiCommentDrafts,
      suggestions
    );
    return (
      props.xpAdjustment !== newXpAdjustmentInput ||
      initialComposedCommentRef.current !== normalizedEditorValue
    );
  };

  const checkIsNewQuestion = () => {
    return props.gradedAt === undefined;
  };

  const copyComposedPromptToClipboard = () => {
    navigator.clipboard.writeText(
      prompts
        .map(prompt => {
          return `**${prompt.role} Prompt**\n\n${prompt.content}`;
        })
        .join('\n\n')
    );
    showSuccessMessage('Composed prompt copied to clipboard!', 2000);
  };

  // Render
  const hasUnsavedChanges = checkHasUnsavedChanges();
  const isNewQuestion = checkIsNewQuestion();
  const saveButtonOpts = {
    intent: hasUnsavedChanges || isNewQuestion ? Intent.WARNING : Intent.NONE,
    minimal: !hasUnsavedChanges && !isNewQuestion,
    disabled: isSaveInFlight,
    className: gradingEditorButtonClass
  };
  const discardButtonOpts = {
    intent: hasUnsavedChanges ? Intent.DANGER : Intent.NONE,
    minimal: !hasUnsavedChanges,
    disabled: isSaveInFlight,
    className: gradingEditorButtonClass
  };
  const saveAndContinueButtonOpts = {
    intent: hasUnsavedChanges || isNewQuestion ? Intent.SUCCESS : Intent.NONE,
    minimal: !hasUnsavedChanges && !isNewQuestion,
    disabled: isSaveInFlight,
    className: gradingEditorButtonClass
  };
  // Derived values
  const totalXp = props.initialXp + (convertParamToInt(xpAdjustmentInput || undefined) || 0);
  const xpPlaceholder = `${props.initialXp > 0 ? '-' : ''}${props.initialXp} to ${
    props.maxXp - props.initialXp
  }`;

  const handleGenerate = async (force: boolean = false) => {
    if (force) {
      const confirm = await showSimpleConfirmDialog({
        contents: (
          <>
            <p>Are you sure? Doing so will result in the previous prompt results being lost.</p>
            <p>
              <b>Note: This will incur additional LLM token costs.</b>
            </p>
          </>
        ),
        positiveLabel: 'Re-generate',
        positiveIntent: Intent.DANGER
      });

      if (!confirm) return;
    }

    setHasClickedGenerate(true);

    try {
      const resp = await postGenerateComments(tokens, props.answer_id, force);

      if (resp && resp.comments) {
        setSuggestions(resp.comments);
        setHasGenerated(true);
        setSelectedIndices([]);
        setAiCommentDrafts({});
        setEditorText(userComment);
        initialComposedCommentRef.current = composeFinalCommentText(
          userComment,
          [],
          {},
          resp.comments
        );
        lastSavedSelectionKeyRef.current = EMPTY_SELECTION_SAVE_KEY;

        showSuccessMessage(force ? 'Comments re-generated!' : 'Comments generated!');
      }
    } catch (error) {
      showWarningMessage('Failed to generate comments. Please try again.');
    } finally {
      setHasClickedGenerate(false);
    }
  };

  return (
    <div className="GradingEditor">
      <Prompt
        when={!currentlySaving && hasUnsavedChanges}
        message={'You have unsaved changes. Are you sure you want to leave?'}
      />

      <div className="grading-editor-header">
        <H3>
          Currently Grading:
          <br />
          {props.studentNames.map((name, index) => (
            <div key={index}>
              <span>
                {name} ({props.studentUsernames[index]})
              </span>
              <br />
            </div>
          ))}
        </H3>
      </div>
      {props.solution !== null ? (
        <div className="grading-editor-marking-scheme">
          <Pre>{props.solution.toString()} </Pre>
        </div>
      ) : null}

      <div className="grading-editor-container">
        <div className="grading-editor-xp">
          <div className="autograder-xp">
            <div>Autograder XP:</div>
            <div>
              {`${props.initialXp} / ${props.maxXp}`}{' '}
              <Button icon="refresh" small minimal onClick={onClickReautogradeAnswer}></Button>
            </div>
          </div>
          <div className="xp-adjustment">
            <div>XP adjustment:</div>
            <div>
              <NumericInput
                className="adjustment-input"
                onValueChange={onXpAdjustmentInputChange}
                value={xpAdjustmentInput || ''}
                buttonPosition={Position.RIGHT}
                fill={true}
                placeholder={xpPlaceholder}
                intent={totalXp < 0 || totalXp > props.maxXp ? Intent.DANGER : Intent.NONE}
                min={0 - props.initialXp}
                max={props.maxXp > props.initialXp ? props.maxXp - props.initialXp : undefined}
                stepSize={50}
                minorStepSize={25}
                majorStepSize={100}
              />
            </div>
          </div>
          <div className="final-xp">
            <div>Final XP:</div>
            <div>{`${totalXp} / ${props.maxXp}`}</div>
          </div>
        </div>
      </div>

      {props.is_llm && (
        <>
          {hasPrompts && (
            <Dialog
              title="Full Composed LLM Prompt"
              icon={IconNames.WRENCH}
              isOpen={isViewLLMPromptOpen}
              onClose={() => setIsViewLLMPromptOpen(false)}
            >
              <div className="llm-prompt-dialog">
                <div className="forenote-section">
                  <span className="forenote">
                    <b>Note:</b> The titles here are provided merely to distinguish the different
                    sections. They are not included in the final prompt.
                  </span>
                  <Button
                    onClick={() => {
                      copyComposedPromptToClipboard();
                    }}
                  >
                    <Icon icon={IconNames.Clipboard} />
                  </Button>
                </div>
                {prompts.map(prompt => {
                  return (
                    <>
                      <H3>{prompt.role} Level Prompt</H3>
                      <Divider />
                      {prompt.content}
                    </>
                  );
                })}
              </div>
            </Dialog>
          )}
          <div style={{ marginBottom: '10px' }}>
            <GradingCommentSelector
              onToggle={onToggleComment}
              isLoading={hasClickedGenerate}
              comments={suggestions}
              selectedIndices={selectedIndices}
            />
            <div style={{ display: 'flex', justifyContent: 'center', gap: '0.5rem' }}>
              {hasPrompts && (
                <Button
                  onClick={async () => {
                    setIsViewLLMPromptOpen(true);
                  }}
                >
                  View Prompt
                </Button>
              )}

              {hasPrompts && (
                <Button
                  intent={hasGenerated ? Intent.NONE : Intent.PRIMARY}
                  loading={hasClickedGenerate}
                  disabled={hasClickedGenerate}
                  onClick={() => handleGenerate(hasGenerated)}
                >
                  {hasGenerated ? 'Re-generate Comments' : 'Generate Comments'}
                </Button>
              )}

              <LLMFeedbackButton
                tokens={tokens}
                assessmentId={props.assessmentId}
                questionId={props.questionId}
              />
            </div>
          </div>
        </>
      )}

      <div
        className="react-mde-parent"
        style={{ border: '1px solid #d8e1e8', borderRadius: '4px' }}
      >
        <textarea
          key={'single-comment-editor'}
          value={editorText}
          placeholder={'Write feedback for the student...'}
          onChange={event => handleEditorTextChange(event.target.value)}
          rows={Math.max(10, editorText.split('\n').length + 1)}
          style={{
            width: '100%',
            border: 'none',
            outline: 'none',
            resize: 'none',
            background: 'transparent',
            padding: '12px',
            fontFamily: 'inherit',
            fontSize: '14px',
            lineHeight: '1.5',
            boxSizing: 'border-box'
          }}
        />
      </div>

      <div className="grading-editor-draft-buttons">
        <div className="grading-editor-save-button">
          <ControlButton
            label="Save Changes"
            icon={IconNames.FLOPPY_DISK}
            onClick={validateXpBeforeSave(onClickSaveChanges)}
            options={saveButtonOpts}
          />
        </div>
        <div className="grading-editor-discard-button">
          <ControlButton
            label="Discard Changes"
            icon={IconNames.TRASH}
            onClick={discardChanges}
            options={discardButtonOpts}
          />
        </div>
      </div>
      <div className="grading-editor-save-continue-button">
        <ControlButton
          label="Save and Continue"
          icon={IconNames.UPDATED}
          onClick={validateXpBeforeSave(onClickSaveAndContinue)}
          options={saveAndContinueButtonOpts}
        />
      </div>
      {props.graderName && props.gradedAt && (
        <>
          <Divider />
          <div className="grading-editor-last-graded-details">
            Last edited by <b>{props.graderName}</b> on {getPrettyDate(props.gradedAt)}
          </div>
        </>
      )}
    </div>
  );
};

export default GradingEditor;
