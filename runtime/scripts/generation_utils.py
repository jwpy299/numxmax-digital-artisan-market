"""Shared causal-LM generation helpers: always decode only newly generated tokens."""


def task_prompt(task: str) -> str:
    task = task.strip()
    if not task:
        raise ValueError("empty_task")
    return f"你是部门数字员工，请按任务要求生成合格产出。\n任务：{task}\n合格产出："


def generate_new_text(model, tokenizer, task: str, no_grad, max_new_tokens: int = 128) -> tuple[str, str]:
    inputs = tokenizer(task_prompt(task), return_tensors="pt", truncation=True, max_length=768)
    prompt_length = int(inputs["input_ids"].shape[1])
    with no_grad():
        output = model.generate(**inputs, max_new_tokens=max_new_tokens, do_sample=False, num_beams=1)
    new_tokens = output[0][prompt_length:]
    generated_count = len(new_tokens)
    eos_id = getattr(tokenizer, "eos_token_id", None)
    hit_eos = generated_count > 0 and eos_id is not None and int(new_tokens[-1]) == int(eos_id)
    finish_reason = "stop" if hit_eos or generated_count < max_new_tokens else "length"
    return tokenizer.decode(new_tokens, skip_special_tokens=True).strip(), finish_reason
